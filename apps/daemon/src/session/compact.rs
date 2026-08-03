//! Bounds normalized tool details before they enter the session timeline.
//!
//! Built-in tools already bound what the model reads. Third-party adapters do
//! not share that implementation, though, and some of them hand us an entire
//! provider event. This is the common client/storage boundary: after this point
//! a tool card is safe to replay, persist and send over a remote connection.

use genehub_proto::{ItemDelta, SearchMatch, SessionEvent, TimelineItem, ToolCallDetail};
use serde_json::{json, Value};

const INLINE_BYTES: usize = 4 * 1024;
const DETAIL_BYTES: usize = 16 * 1024;
const DETAIL_LINES: usize = 200;
const SEARCH_MATCHES: usize = 100;
const SUB_AGENT_ITEMS: usize = 50;
const MARKER: &str = "…（详情已裁剪）";

pub(super) fn event(event: &mut SessionEvent) {
    match event {
        SessionEvent::Item {
            item: TimelineItem::ToolCall { detail, .. },
            ..
        } => detail_in_place(detail),
        SessionEvent::ItemDelta {
            delta:
                ItemDelta::ToolStatus {
                    detail: Some(detail),
                    ..
                },
            ..
        } => detail_in_place(detail),
        _ => {}
    }
}

fn detail_in_place(detail: &mut ToolCallDetail) {
    match detail {
        ToolCallDetail::Shell {
            command, output, ..
        } => {
            *command = head(command, 20, INLINE_BYTES).0;
            *output = tail(output, DETAIL_LINES, DETAIL_BYTES).0;
        }
        ToolCallDetail::Read {
            path,
            content,
            truncated,
        } => {
            *path = head(path, 20, INLINE_BYTES).0;
            let (kept, cut) = head(content, DETAIL_LINES, DETAIL_BYTES);
            *content = kept;
            *truncated |= cut;
        }
        ToolCallDetail::Edit { path, diff } => {
            *path = head(path, 20, INLINE_BYTES).0;
            *diff = head(diff, DETAIL_LINES, DETAIL_BYTES).0;
        }
        ToolCallDetail::Write { path, content } => {
            *path = head(path, 20, INLINE_BYTES).0;
            *content = head(content, DETAIL_LINES, DETAIL_BYTES).0;
        }
        ToolCallDetail::Search { query, matches } => {
            *query = head(query, 20, INLINE_BYTES).0;
            for found in matches.iter_mut().take(SEARCH_MATCHES) {
                found.path = head(&found.path, 20, INLINE_BYTES).0;
                found.preview = head(&found.preview, 20, INLINE_BYTES).0;
            }
            if matches.len() > SEARCH_MATCHES {
                matches.truncate(SEARCH_MATCHES);
                matches.push(SearchMatch {
                    path: MARKER.into(),
                    line: None,
                    preview: String::new(),
                });
            }
        }
        ToolCallDetail::Fetch { url, summary } => {
            *url = head(url, 20, INLINE_BYTES).0;
            *summary = head(summary, DETAIL_LINES, DETAIL_BYTES).0;
        }
        ToolCallDetail::Plan { markdown } => {
            *markdown = head(markdown, DETAIL_LINES, DETAIL_BYTES).0;
        }
        ToolCallDetail::SubAgent {
            agent,
            prompt,
            items,
        } => {
            *agent = head(agent, 20, INLINE_BYTES).0;
            *prompt = head(prompt, DETAIL_LINES, DETAIL_BYTES).0;
            for item in items.iter_mut().take(SUB_AGENT_ITEMS) {
                nested_item(item);
            }
            if items.len() > SUB_AGENT_ITEMS {
                items.truncate(SUB_AGENT_ITEMS);
                items.push(TimelineItem::Compaction {
                    id: "tool-detail-truncated".into(),
                    reason: MARKER.into(),
                });
            }
        }
        ToolCallDetail::Unknown { raw } => compact_unknown(raw),
    }
}

fn nested_item(item: &mut TimelineItem) {
    match item {
        TimelineItem::UserMessage {
            text, attachments, ..
        } => {
            *text = head(text, DETAIL_LINES, DETAIL_BYTES).0;
            // Inline attachment data is already represented elsewhere in the
            // parent session. It must not multiply inside a tool card replay.
            for attachment in attachments {
                attachment.data_base64 = None;
            }
        }
        TimelineItem::AssistantMessage { text, .. } | TimelineItem::Reasoning { text, .. } => {
            *text = head(text, DETAIL_LINES, DETAIL_BYTES).0;
        }
        TimelineItem::ToolCall { detail, .. } => detail_in_place(detail),
        TimelineItem::Todo { items, .. } => {
            for todo in items {
                todo.text = head(&todo.text, 20, INLINE_BYTES).0;
            }
        }
        TimelineItem::Compaction { reason, .. } => {
            *reason = head(reason, 20, INLINE_BYTES).0;
        }
        TimelineItem::Error { message, .. } => {
            *message = head(message, DETAIL_LINES, DETAIL_BYTES).0;
        }
    }
}

fn compact_unknown(raw: &mut Value) {
    let Ok(encoded) = serde_json::to_string(raw) else {
        *raw = json!({ "truncated": true, "preview": MARKER });
        return;
    };
    let (preview, truncated) = head(&encoded, DETAIL_LINES, DETAIL_BYTES);
    if truncated {
        *raw = json!({
            "truncated": true,
            "preview": preview,
        });
    }
}

fn head(source: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    let mut end = 0;
    let mut lines = 1;
    for (index, character) in source.char_indices() {
        let next = index + character.len_utf8();
        if next > max_bytes || (character == '\n' && lines >= max_lines) {
            break;
        }
        end = next;
        if character == '\n' {
            lines += 1;
        }
    }
    if end == source.len() {
        return (source.to_string(), false);
    }
    let kept = source[..end].trim_end();
    (
        if kept.is_empty() {
            MARKER.into()
        } else {
            format!("{kept}\n{MARKER}")
        },
        true,
    )
}

fn tail(source: &str, max_lines: usize, max_bytes: usize) -> (String, bool) {
    let line_start = if source.lines().count() > max_lines {
        source
            .match_indices('\n')
            .rev()
            .nth(max_lines - 1)
            .map(|(index, _)| index + 1)
            .unwrap_or(0)
    } else {
        0
    };
    let byte_start = source.len().saturating_sub(max_bytes);
    let mut start = line_start.max(byte_start);
    while start < source.len() && !source.is_char_boundary(start) {
        start += 1;
    }
    if start == 0 {
        return (source.to_string(), false);
    }
    let kept = source[start..].trim_start();
    (
        if kept.is_empty() {
            MARKER.into()
        } else {
            format!("{MARKER}\n{kept}")
        },
        true,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::ToolStatus;

    #[test]
    fn shell_keeps_the_useful_tail_and_marks_the_cut() {
        let mut incoming = SessionEvent::Item {
            turn_id: "t".into(),
            item: TimelineItem::ToolCall {
                id: "tool".into(),
                name: "Shell".into(),
                status: ToolStatus::Ok,
                detail: ToolCallDetail::Shell {
                    command: "run".into(),
                    output: (0..400).map(|line| format!("line {line}\n")).collect(),
                    exit_code: Some(0),
                },
            },
        };

        event(&mut incoming);

        let SessionEvent::Item {
            item:
                TimelineItem::ToolCall {
                    detail: ToolCallDetail::Shell { output, .. },
                    ..
                },
            ..
        } = incoming
        else {
            panic!("wrong event shape")
        };
        assert!(output.starts_with(MARKER));
        assert!(!output.contains("line 0\n"));
        assert!(output.contains("line 399"));
    }

    #[test]
    fn unknown_provider_payload_becomes_a_bounded_preview() {
        let mut raw = json!({ "output": "x".repeat(DETAIL_BYTES * 2) });
        compact_unknown(&mut raw);
        assert_eq!(raw["truncated"], true);
        assert!(serde_json::to_vec(&raw).unwrap().len() < DETAIL_BYTES + 256);
    }

    #[test]
    fn read_preserves_an_existing_truncation_and_marks_ours() {
        let mut detail = ToolCallDetail::Read {
            path: "large.txt".into(),
            content: "x\n".repeat(DETAIL_LINES + 1),
            truncated: false,
        };
        detail_in_place(&mut detail);
        assert!(matches!(
            detail,
            ToolCallDetail::Read {
                truncated: true,
                ..
            }
        ));
    }
}
