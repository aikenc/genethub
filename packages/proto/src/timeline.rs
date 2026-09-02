//! The normalized timeline: what every agent's output is translated into.
//!
//! Boundary B2 in `docs/architecture.md` makes this the product's own shape
//! rather than any single agent's wire format. Adapters translate into it; the
//! frontend and the on-disk session log only ever see these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::domain::ImageThumb;
use crate::event::TurnStats;

/// A stable semantic category shared by every Agent adapter.
///
/// Tool names are Agent-specific (`Bash`, `commandExecution`, `execute`), while
/// the activity icon should mean the same thing everywhere.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ToolKind {
    Shell,
    Read,
    Write,
    Edit,
    Search,
    Fetch,
    Plan,
    SubAgent,
    Mcp,
    #[default]
    Other,
}

/// Which renderer the frontend should reach for.
///
/// Adapters map their agent's tool names onto these variants. The mapping table
/// lives inside each adapter on purpose: a single global table would become a
/// coupling point between every adapter we ever add.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ToolCallDetail {
    /// The only tool shape retained by the session boundary. Adapters may
    /// produce richer variants below, but memory, disk and clients receive
    /// a compact header, one input line, and a four-line output excerpt.
    #[serde(rename_all = "camelCase")]
    Overview {
        #[serde(default)]
        tool_kind: ToolKind,
        overview: String,
        input: String,
        output: String,
    },
    #[serde(rename_all = "camelCase")]
    Shell {
        command: String,
        output: String,
        #[ts(optional)]
        exit_code: Option<i32>,
    },
    #[serde(rename_all = "camelCase")]
    Read {
        path: String,
        content: String,
        truncated: bool,
    },
    #[serde(rename_all = "camelCase")]
    Edit { path: String, diff: String },
    #[serde(rename_all = "camelCase")]
    Write { path: String, content: String },
    #[serde(rename_all = "camelCase")]
    Search {
        query: String,
        matches: Vec<SearchMatch>,
    },
    #[serde(rename_all = "camelCase")]
    Fetch { url: String, summary: String },
    #[serde(rename_all = "camelCase")]
    Plan { markdown: String },
    #[serde(rename_all = "camelCase")]
    SubAgent {
        agent: String,
        prompt: String,
        items: Vec<TimelineItem>,
    },
    /// The fallback that keeps unknown agents renderable. Never drop an event
    /// just because we have no dedicated renderer for it.
    #[serde(rename_all = "camelCase")]
    Unknown { raw: Value },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct SearchMatch {
    pub path: String,
    #[ts(optional)]
    pub line: Option<u32>,
    pub preview: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ToolStatus {
    Pending,
    Running,
    Ok,
    Error,
    Canceled,
}

/// An image the agent read or produced, extracted from a tool result.
///
/// `data_base64` is adapter→daemon transport only: the daemon strips it at
/// intake — thumbnails are generated, produced images move to the blob layer,
/// read images keep only their workspace path — before the item is persisted,
/// condensed or published. It must never reach disk or clients.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ToolImage {
    /// Source description, e.g. `Read: assets/logo.png` or a tool name.
    pub alt: String,
    pub mime: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub data_base64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub thumb: Option<ImageThumb>,
    /// Workspace-relative path when the image is a file the agent read.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Attachment {
    pub name: String,
    pub mime: String,
    #[ts(optional)]
    pub path: Option<String>,
    /// Inline payload, base64. Only set for small pastes such as screenshots.
    #[ts(optional)]
    pub data_base64: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct TodoEntry {
    pub text: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

/// One entry in a session's timeline.
///
/// `id` is assigned by the daemon, not the agent, so that deltas can address an
/// item regardless of whether the underlying agent has a concept of message ids.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum TimelineItem {
    #[serde(rename_all = "camelCase")]
    UserMessage {
        id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    #[serde(rename_all = "camelCase")]
    AssistantMessage { id: String, text: String },
    /// Thinking, reasoning and extended-thought blocks all land here.
    #[serde(rename_all = "camelCase")]
    Reasoning { id: String, text: String },
    #[serde(rename_all = "camelCase")]
    ToolCall {
        id: String,
        name: String,
        status: ToolStatus,
        detail: ToolCallDetail,
        /// Images this call's result carried, in shed form (see `ToolImage`).
        #[serde(default)]
        images: Vec<ToolImage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        started_at_ms: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        finished_at_ms: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Todo { id: String, items: Vec<TodoEntry> },
    #[serde(rename_all = "camelCase")]
    Compaction { id: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Error { id: String, message: String },
    /// The durable footer for one completed, failed or canceled turn.
    #[serde(rename_all = "camelCase")]
    TurnSummary { id: String, stats: TurnStats },
}

impl TimelineItem {
    pub fn id(&self) -> &str {
        match self {
            TimelineItem::UserMessage { id, .. }
            | TimelineItem::AssistantMessage { id, .. }
            | TimelineItem::Reasoning { id, .. }
            | TimelineItem::ToolCall { id, .. }
            | TimelineItem::Todo { id, .. }
            | TimelineItem::Compaction { id, .. }
            | TimelineItem::Error { id, .. }
            | TimelineItem::TurnSummary { id, .. } => id,
        }
    }

    /// Appends streamed text to whichever field this item streams into.
    ///
    /// Returns false for items that have no streaming text, which lets the
    /// caller treat "delta for a non-streaming item" as a protocol error rather
    /// than silently dropping it.
    pub fn append_text(&mut self, delta: &str) -> bool {
        match self {
            TimelineItem::AssistantMessage { text, .. }
            | TimelineItem::Reasoning { text, .. }
            | TimelineItem::UserMessage { text, .. } => {
                text.push_str(delta);
                true
            }
            _ => false,
        }
    }

    pub fn is_terminal_tool(status: ToolStatus) -> bool {
        matches!(
            status,
            ToolStatus::Ok | ToolStatus::Error | ToolStatus::Canceled
        )
    }

    /// First sighting records start; a terminal status records finish. Never
    /// overwrites a time the adapter or an earlier stamp already set.
    pub fn stamp_tool_times(&mut self, now: i64) {
        let TimelineItem::ToolCall {
            status,
            started_at_ms,
            finished_at_ms,
            ..
        } = self
        else {
            return;
        };
        if started_at_ms.is_none() {
            *started_at_ms = Some(now);
        }
        if Self::is_terminal_tool(*status) && finished_at_ms.is_none() {
            let start = started_at_ms.unwrap_or(now);
            *finished_at_ms = Some(now.max(start));
        }
    }

    pub fn preserve_tool_times(&mut self, previous: &TimelineItem) {
        let TimelineItem::ToolCall {
            started_at_ms: prev_start,
            finished_at_ms: prev_end,
            ..
        } = previous
        else {
            return;
        };
        let TimelineItem::ToolCall {
            started_at_ms,
            finished_at_ms,
            ..
        } = self
        else {
            return;
        };
        *started_at_ms = earlier_ms(*started_at_ms, *prev_start);
        *finished_at_ms = earlier_ms(*finished_at_ms, *prev_end);
    }

    /// Carry times from the in-memory item, then stamp any still-missing
    /// start/finish. A completed replacement must inherit the first sighting
    /// before `now` is written, or live elapsed collapses to zero.
    pub fn inherit_and_stamp_tool_times(&mut self, previous: Option<&TimelineItem>, now: i64) {
        if let Some(previous) = previous {
            self.preserve_tool_times(previous);
        }
        self.stamp_tool_times(now);
    }
}

fn earlier_ms(left: Option<i64>, right: Option<i64>) -> Option<i64> {
    match (left, right) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool(status: ToolStatus, started: Option<i64>, finished: Option<i64>) -> TimelineItem {
        TimelineItem::ToolCall {
            id: "t".into(),
            name: "shell".into(),
            status,
            detail: ToolCallDetail::Overview {
                tool_kind: ToolKind::Shell,
                overview: "cargo check".into(),
                input: "cargo check".into(),
                output: String::new(),
            },
            images: vec![],
            started_at_ms: started,
            finished_at_ms: finished,
        }
    }

    fn times(item: &TimelineItem) -> (Option<i64>, Option<i64>) {
        match item {
            TimelineItem::ToolCall {
                started_at_ms,
                finished_at_ms,
                ..
            } => (*started_at_ms, *finished_at_ms),
            _ => panic!("expected tool"),
        }
    }

    #[test]
    fn a_terminal_replacement_keeps_the_first_start() {
        let running = tool(ToolStatus::Running, Some(1_000), None);
        let mut done = tool(ToolStatus::Ok, None, None);
        done.inherit_and_stamp_tool_times(Some(&running), 21_000);
        assert_eq!(times(&done), (Some(1_000), Some(21_000)));
    }

    #[test]
    fn a_restamped_terminal_item_does_not_win_over_the_first_start() {
        let running = tool(ToolStatus::Running, Some(1_000), None);
        let mut done = tool(ToolStatus::Ok, Some(21_000), Some(21_000));
        done.inherit_and_stamp_tool_times(Some(&running), 21_000);
        assert_eq!(times(&done), (Some(1_000), Some(21_000)));
    }
}
