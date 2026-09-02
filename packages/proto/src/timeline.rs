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

impl ToolCallDetail {
    /// Fills empty fields from a previous version of the same call.
    ///
    /// A bare completion update carries only the output and degrades to an
    /// `Overview` with empty overview/input; when the call started with a
    /// typed detail, the typed shape wins and merely adopts the new output.
    pub fn fill_from(&mut self, previous: &ToolCallDetail) {
        let (bare_overview, incoming_output) = match self {
            ToolCallDetail::Overview {
                overview,
                input,
                output,
                ..
            } => (
                overview.trim().is_empty() && input.trim().is_empty(),
                output.clone(),
            ),
            _ => (false, String::new()),
        };
        if bare_overview
            && !matches!(
                previous,
                ToolCallDetail::Overview { .. } | ToolCallDetail::Unknown { .. }
            )
        {
            let mut adopted = previous.clone();
            if !incoming_output.is_empty() {
                adopted.set_primary_output(incoming_output);
            }
            *self = adopted;
            return;
        }
        match (self, previous) {
            (
                ToolCallDetail::Overview {
                    tool_kind,
                    overview,
                    input,
                    output,
                },
                ToolCallDetail::Overview {
                    tool_kind: prev_kind,
                    overview: prev_overview,
                    input: prev_input,
                    output: prev_output,
                },
            ) => {
                if *tool_kind == ToolKind::Other {
                    *tool_kind = *prev_kind;
                }
                if overview.is_empty() {
                    *overview = prev_overview.clone();
                }
                if input.is_empty() {
                    *input = prev_input.clone();
                }
                if output.is_empty() {
                    *output = prev_output.clone();
                }
            }
            (
                ToolCallDetail::Shell {
                    command,
                    output,
                    exit_code,
                },
                ToolCallDetail::Shell {
                    command: prev_command,
                    output: prev_output,
                    exit_code: prev_exit,
                },
            ) => {
                if command.is_empty() {
                    *command = prev_command.clone();
                }
                if output.is_empty() {
                    *output = prev_output.clone();
                }
                if exit_code.is_none() {
                    *exit_code = *prev_exit;
                }
            }
            (
                ToolCallDetail::Read {
                    path,
                    content,
                    truncated,
                },
                ToolCallDetail::Read {
                    path: prev_path,
                    content: prev_content,
                    truncated: prev_truncated,
                },
            ) => {
                if path.is_empty() {
                    *path = prev_path.clone();
                }
                if content.is_empty() {
                    *content = prev_content.clone();
                }
                if !*truncated {
                    *truncated = *prev_truncated;
                }
            }
            (
                ToolCallDetail::Edit { path, diff },
                ToolCallDetail::Edit {
                    path: prev_path,
                    diff: prev_diff,
                },
            ) => {
                if path.is_empty() {
                    *path = prev_path.clone();
                }
                if diff.is_empty() {
                    *diff = prev_diff.clone();
                }
            }
            (
                ToolCallDetail::Write { path, content },
                ToolCallDetail::Write {
                    path: prev_path,
                    content: prev_content,
                },
            ) => {
                if path.is_empty() {
                    *path = prev_path.clone();
                }
                if content.is_empty() {
                    *content = prev_content.clone();
                }
            }
            (
                ToolCallDetail::Search { query, matches },
                ToolCallDetail::Search {
                    query: prev_query,
                    matches: prev_matches,
                },
            ) => {
                if query.is_empty() {
                    *query = prev_query.clone();
                }
                if matches.is_empty() {
                    *matches = prev_matches.clone();
                }
            }
            (
                ToolCallDetail::Fetch { url, summary },
                ToolCallDetail::Fetch {
                    url: prev_url,
                    summary: prev_summary,
                },
            ) => {
                if url.is_empty() {
                    *url = prev_url.clone();
                }
                if summary.is_empty() {
                    *summary = prev_summary.clone();
                }
            }
            _ => {}
        }
    }

    /// Replaces the field that holds this variant's result payload.
    fn set_primary_output(&mut self, output: String) {
        match self {
            ToolCallDetail::Overview { output: slot, .. } => *slot = output,
            ToolCallDetail::Shell { output: slot, .. } => *slot = output,
            ToolCallDetail::Read { content, .. } => *content = output,
            ToolCallDetail::Edit { diff, .. } => *diff = output,
            ToolCallDetail::Write { content, .. } => *content = output,
            ToolCallDetail::Fetch { summary, .. } => *summary = output,
            _ => {}
        }
    }
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
    AssistantMessage {
        id: String,
        text: String,
        /// When the daemon first saw this item. Drives batch/trunk timing for
        /// items that carry no tool timestamps of their own.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        received_at_ms: Option<i64>,
    },
    /// Thinking, reasoning and extended-thought blocks all land here.
    #[serde(rename_all = "camelCase")]
    Reasoning {
        id: String,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        received_at_ms: Option<i64>,
    },
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
    Compaction {
        id: String,
        reason: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        received_at_ms: Option<i64>,
    },
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

    /// First sighting records when the daemon received the item. Only the
    /// trunk-tracked variants without tool timestamps carry the field.
    pub fn stamp_received_at(&mut self, now: i64) {
        match self {
            TimelineItem::AssistantMessage { received_at_ms, .. }
            | TimelineItem::Reasoning { received_at_ms, .. }
            | TimelineItem::Compaction { received_at_ms, .. } => {
                if received_at_ms.is_none() {
                    *received_at_ms = Some(now);
                }
            }
            _ => {}
        }
    }

    /// A replacement item keeps the first sighting's receive time; only a
    /// genuinely new sighting stamps `now`.
    pub fn inherit_and_stamp_received_at(&mut self, previous: Option<&TimelineItem>, now: i64) {
        let previous_at = previous.and_then(TimelineItem::received_at_ms);
        match self.received_at_ms_mut() {
            Some(slot) => {
                if slot.is_none() {
                    *slot = previous_at.or(Some(now));
                }
            }
            None => {}
        }
    }

    /// The receive time shared by the timestamped non-tool variants.
    pub fn received_at_ms(&self) -> Option<i64> {
        match self {
            TimelineItem::AssistantMessage { received_at_ms, .. }
            | TimelineItem::Reasoning { received_at_ms, .. }
            | TimelineItem::Compaction { received_at_ms, .. } => *received_at_ms,
            _ => None,
        }
    }

    fn received_at_ms_mut(&mut self) -> Option<&mut Option<i64>> {
        match self {
            TimelineItem::AssistantMessage { received_at_ms, .. }
            | TimelineItem::Reasoning { received_at_ms, .. }
            | TimelineItem::Compaction { received_at_ms, .. } => Some(received_at_ms),
            _ => None,
        }
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

    /// Merges a replacement tool call with the item it replaces.
    ///
    /// Adapters that split one call into an initial event and later
    /// status/content updates (ACP `tool_call` → `tool_call_update`) may omit
    /// the name or detail fields in the updates. Empty incoming fields inherit
    /// the previous values, so a bare completion update cannot blank a card
    /// the initial event filled in.
    pub fn merge_tool_update(&mut self, previous: Option<&TimelineItem>) {
        let Some(TimelineItem::ToolCall {
            name: prev_name,
            detail: prev_detail,
            images: prev_images,
            ..
        }) = previous
        else {
            return;
        };
        let TimelineItem::ToolCall {
            name,
            detail,
            images,
            ..
        } = self
        else {
            return;
        };
        if name.is_empty() {
            *name = prev_name.clone();
        }
        if images.is_empty() {
            *images = prev_images.clone();
        }
        detail.fill_from(prev_detail);
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

    fn read_call(name: &str, path: &str, content: &str) -> TimelineItem {
        TimelineItem::ToolCall {
            id: "t".into(),
            name: name.into(),
            status: ToolStatus::Running,
            detail: ToolCallDetail::Read {
                path: path.into(),
                content: content.into(),
                truncated: false,
            },
            images: vec![],
            started_at_ms: None,
            finished_at_ms: None,
        }
    }

    #[test]
    fn a_bare_completion_update_inherits_the_name_and_typed_detail() {
        // ACP shape: the initial event carries title/kind, the completion
        // update only carries status and rawOutput.
        let started = read_call("Read File", "src/main.rs", "");
        let mut completed = TimelineItem::ToolCall {
            id: "t".into(),
            name: String::new(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Overview {
                tool_kind: ToolKind::Other,
                overview: String::new(),
                input: String::new(),
                output: "fn main() {}".into(),
            },
            images: vec![],
            started_at_ms: None,
            finished_at_ms: None,
        };
        completed.merge_tool_update(Some(&started));
        match completed {
            TimelineItem::ToolCall { name, detail, .. } => {
                assert_eq!(name, "Read File");
                assert_eq!(
                    detail,
                    ToolCallDetail::Read {
                        path: "src/main.rs".into(),
                        content: "fn main() {}".into(),
                        truncated: false,
                    }
                );
            }
            _ => panic!("expected tool"),
        }
    }

    #[test]
    fn an_overview_update_fills_only_its_empty_fields() {
        let started = tool(ToolStatus::Running, None, None);
        let mut completed = TimelineItem::ToolCall {
            id: "t".into(),
            name: String::new(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Overview {
                tool_kind: ToolKind::Other,
                overview: String::new(),
                input: String::new(),
                output: "done".into(),
            },
            images: vec![],
            started_at_ms: None,
            finished_at_ms: None,
        };
        completed.merge_tool_update(Some(&started));
        match completed {
            TimelineItem::ToolCall { name, detail, .. } => {
                assert_eq!(name, "shell");
                assert_eq!(
                    detail,
                    ToolCallDetail::Overview {
                        tool_kind: ToolKind::Shell,
                        overview: "cargo check".into(),
                        input: "cargo check".into(),
                        output: "done".into(),
                    }
                );
            }
            _ => panic!("expected tool"),
        }
    }

    #[test]
    fn a_richer_incoming_detail_is_not_diluted_by_the_previous_one() {
        let started = read_call("Read File", "", "");
        let mut completed = read_call("Read File", "src/lib.rs", "pub fn x() {}");
        completed.merge_tool_update(Some(&started));
        match completed {
            TimelineItem::ToolCall { detail, .. } => assert_eq!(
                detail,
                ToolCallDetail::Read {
                    path: "src/lib.rs".into(),
                    content: "pub fn x() {}".into(),
                    truncated: false,
                }
            ),
            _ => panic!("expected tool"),
        }
    }
}
