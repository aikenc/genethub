//! The normalized timeline: what every agent's output is translated into.
//!
//! Boundary B2 in `docs/architecture.md` makes this the product's own shape
//! rather than any single agent's wire format. Adapters translate into it; the
//! frontend and the on-disk session log only ever see these types.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

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
    /// three human-scannable strings of at most 24 Unicode characters each.
    #[serde(rename_all = "camelCase")]
    Overview {
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
    },
    #[serde(rename_all = "camelCase")]
    Todo { id: String, items: Vec<TodoEntry> },
    #[serde(rename_all = "camelCase")]
    Compaction { id: String, reason: String },
    #[serde(rename_all = "camelCase")]
    Error { id: String, message: String },
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
            | TimelineItem::Error { id, .. } => id,
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
}
