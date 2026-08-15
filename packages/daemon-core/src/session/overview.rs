//! Bounded tool and reasoning views applied at the portable session boundary.
//!
//! Adapters may retain faithful source detail long enough for the round/blob
//! ledger, but replay, snapshots and client publications receive only this
//! compact shape. This keeps secrets and unbounded command/file output out of
//! the ordinary timeline without teaching the native platform any policy.

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail, ToolKind};

pub const OVERVIEW_CHARS: usize = 48;
pub const SUMMARY_CHARS: usize = 64;
pub const TOOL_LINE_CHARS: usize = 64;
pub const REASONING_CHARS: usize = 24;

pub fn shorten(text: &str, max: usize) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    clip(line, max)
}

fn one_line(text: &str, max: usize) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

fn clip(text: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut taken: String = text.chars().take(max - 1).collect();
    taken.push('…');
    taken
}

fn output_excerpt(text: &str) -> String {
    let mut lines: Vec<&str> = text.lines().collect();
    while lines.first().is_some_and(|line| line.trim().is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let bounded = |line: &&str| clip(line.trim_end_matches('\r'), TOOL_LINE_CHARS);
    if lines.len() <= 4 {
        return lines.iter().map(bounded).collect::<Vec<_>>().join("\n");
    }
    let mut kept = lines[..2].iter().map(bounded).collect::<Vec<_>>();
    kept.push(format!("… 已省略 {} 行 …", lines.len() - 4));
    kept.extend(lines[lines.len() - 2..].iter().map(bounded));
    kept.join("\n")
}

fn header(provided: &str, input: &str, output: &str, fallback: &str) -> String {
    let input = one_line(input, TOOL_LINE_CHARS);
    let provided = one_line(provided, OVERVIEW_CHARS);
    if provided.is_empty() {
        let direct = first_nonempty(&[&input, output, fallback])
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        return clip(&direct, SUMMARY_CHARS);
    }
    if input.is_empty() || input == provided {
        return provided;
    }
    let separator = " · ";
    let remaining =
        SUMMARY_CHARS.saturating_sub(provided.chars().count() + separator.chars().count());
    if remaining == 0 {
        return provided;
    }
    format!("{provided}{separator}{}", clip(&input, remaining))
}

pub fn condense_event(event: &SessionEvent) -> SessionEvent {
    match event {
        SessionEvent::Item { turn_id, item } => SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: condense_item(item),
        },
        SessionEvent::ItemDelta {
            turn_id,
            item_id,
            delta: ItemDelta::ToolStatus { status, detail },
        } => SessionEvent::ItemDelta {
            turn_id: turn_id.clone(),
            item_id: item_id.clone(),
            delta: ItemDelta::ToolStatus {
                status: *status,
                detail: detail.as_ref().map(|detail| condense_detail(detail, None)),
            },
        },
        other => other.clone(),
    }
}

pub fn condense_item(item: &TimelineItem) -> TimelineItem {
    match item {
        TimelineItem::Reasoning { id, text } => TimelineItem::Reasoning {
            id: id.clone(),
            text: shorten(text, REASONING_CHARS),
        },
        TimelineItem::ToolCall {
            id,
            name,
            status,
            detail,
        } => TimelineItem::ToolCall {
            id: id.clone(),
            name: shorten(name, OVERVIEW_CHARS),
            status: *status,
            detail: condense_detail(detail, Some(name)),
        },
        other => other.clone(),
    }
}

fn condense_detail(detail: &ToolCallDetail, fallback_name: Option<&str>) -> ToolCallDetail {
    let (kind, provided, input, output) = match detail {
        ToolCallDetail::Overview {
            tool_kind,
            overview,
            input,
            output,
        } => (
            if *tool_kind == ToolKind::Other {
                kind_from_name(fallback_name.unwrap_or_default())
            } else {
                *tool_kind
            },
            if overview.trim() == input.trim() {
                String::new()
            } else {
                overview.clone()
            },
            input.clone(),
            output.clone(),
        ),
        ToolCallDetail::Shell {
            command, output, ..
        } => (
            ToolKind::Shell,
            String::new(),
            command.clone(),
            output.clone(),
        ),
        ToolCallDetail::Read { path, content, .. } => {
            (ToolKind::Read, String::new(), path.clone(), content.clone())
        }
        ToolCallDetail::Write { path, content } => (
            ToolKind::Write,
            String::new(),
            path.clone(),
            content.clone(),
        ),
        ToolCallDetail::Edit { path, diff } => {
            (ToolKind::Edit, String::new(), path.clone(), diff.clone())
        }
        ToolCallDetail::Search { query, matches } => {
            let output = matches
                .iter()
                .map(|found| {
                    let line = found
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default();
                    format!("{}{line} {}", found.path, found.preview)
                })
                .collect::<Vec<_>>()
                .join("\n");
            (ToolKind::Search, String::new(), query.clone(), output)
        }
        ToolCallDetail::Fetch { url, summary } => {
            (ToolKind::Fetch, String::new(), url.clone(), summary.clone())
        }
        ToolCallDetail::Plan { markdown } => (
            ToolKind::Plan,
            String::new(),
            markdown.clone(),
            String::new(),
        ),
        ToolCallDetail::SubAgent {
            agent,
            prompt,
            items,
        } => {
            let output = items.iter().find_map(item_overview).unwrap_or_default();
            (ToolKind::SubAgent, agent.clone(), prompt.clone(), output)
        }
        ToolCallDetail::Unknown { raw } => {
            let input = raw_field(raw, &["input", "arguments"]);
            let output = raw_field(raw, &["output", "result"]);
            let provided = raw_field(raw, &["overview", "summary", "description", "title"]);
            let encoded = serde_json::to_string(raw).unwrap_or_default();
            (
                kind_from_name(fallback_name.unwrap_or_default()),
                provided,
                first_nonempty(&[&input, &encoded]).to_string(),
                output,
            )
        }
    };
    ToolCallDetail::Overview {
        tool_kind: kind,
        overview: header(
            &provided,
            &input,
            &output,
            fallback_name.unwrap_or_default(),
        ),
        input: one_line(&input, TOOL_LINE_CHARS),
        output: output_excerpt(&output),
    }
}

fn kind_from_name(name: &str) -> ToolKind {
    let name = name.to_ascii_lowercase();
    if name.starts_with("mcp__") || name.contains("mcp") {
        return ToolKind::Mcp;
    }
    match name.as_str() {
        "bash" | "shell" | "execute" | "commandexecution" | "exec" => ToolKind::Shell,
        "read" | "read_file" | "readfile" => ToolKind::Read,
        "write" | "write_file" | "create_file" => ToolKind::Write,
        "edit" | "patch" | "apply_patch" | "filechange" => ToolKind::Edit,
        "grep" | "glob" | "find" | "ls" | "list" | "search" => ToolKind::Search,
        "fetch" | "webfetch" | "websearch" | "web_search" | "open_url" => ToolKind::Fetch,
        "plan" | "todowrite" | "todoread" => ToolKind::Plan,
        "task" | "subagent" | "collabagenttoolcall" => ToolKind::SubAgent,
        _ => ToolKind::Other,
    }
}

fn first_nonempty<'a>(values: &[&'a str]) -> &'a str {
    values
        .iter()
        .copied()
        .find(|value| !value.trim().is_empty())
        .unwrap_or_default()
}

fn raw_field(raw: &serde_json::Value, names: &[&str]) -> String {
    for name in names {
        let Some(value) = raw.get(name) else { continue };
        return value
            .as_str()
            .map(str::to_string)
            .unwrap_or_else(|| serde_json::to_string(value).unwrap_or_default());
    }
    String::new()
}

fn item_overview(item: &TimelineItem) -> Option<String> {
    match item {
        TimelineItem::UserMessage { text, .. }
        | TimelineItem::AssistantMessage { text, .. }
        | TimelineItem::Reasoning { text, .. } => Some(text.clone()),
        TimelineItem::ToolCall { name, detail, .. } => match condense_detail(detail, Some(name)) {
            ToolCallDetail::Overview { overview, .. } => Some(overview),
            _ => unreachable!("condense_detail always returns an overview"),
        },
        TimelineItem::Todo { items, .. } => items.first().map(|item| item.text.clone()),
        TimelineItem::Compaction { reason, .. } => Some(reason.clone()),
        TimelineItem::Error { message, .. } => Some(message.clone()),
        TimelineItem::TurnSummary { .. } => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::ToolStatus;

    #[test]
    fn raw_tool_details_become_bounded_overviews() {
        let item = TimelineItem::ToolCall {
            id: "call".into(),
            name: "bash".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Shell {
                command: "seq 1 200000".into(),
                output: "line\n".repeat(200_000),
                exit_code: Some(0),
            },
        };
        let TimelineItem::ToolCall { detail, .. } = condense_item(&item) else {
            panic!("tool item changed shape")
        };
        let ToolCallDetail::Overview {
            overview,
            input,
            output,
            ..
        } = detail
        else {
            panic!("raw detail escaped")
        };
        assert_eq!(overview, "seq 1 200000");
        assert_eq!(input, "seq 1 200000");
        assert!(output.lines().count() <= 5);
        assert!(output.lines().all(|line| line.chars().count() <= 64));
    }

    #[test]
    fn reasoning_and_unknown_payloads_are_bounded() {
        let reasoning = TimelineItem::Reasoning {
            id: "r".into(),
            text: "字".repeat(100),
        };
        assert!(matches!(
            condense_item(&reasoning),
            TimelineItem::Reasoning { text, .. } if text.chars().count() == REASONING_CHARS
        ));
        let unknown = ToolCallDetail::Unknown {
            raw: serde_json::json!({"arguments": "x".repeat(1000), "output": "y\n".repeat(1000)}),
        };
        let ToolCallDetail::Overview { input, output, .. } =
            condense_detail(&unknown, Some("future-tool"))
        else {
            panic!("unknown detail escaped")
        };
        assert!(input.chars().count() <= TOOL_LINE_CHARS);
        assert!(output.lines().count() <= 5);
    }
}
