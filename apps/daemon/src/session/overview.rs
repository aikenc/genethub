//! Overview-only tool and reasoning events, applied at the session boundary.
//!
//! Tool calls and thinking are where a session's weight lives: a shell
//! command's whole output, a file's whole content, a diff, the raw frame of a
//! tool nobody has a renderer for, and a thinking block that streams one
//! message per token. None of that is what a person scanning the timeline is
//! looking for — they want a tiny label that says what the agent did.
//!
//! This is the one place the detail is shed, and it is deliberately the
//! access layer rather than the adapters (`docs/architecture.md` boundary B1
//! is what makes that possible): every agent's events pass through
//! `pump_events`, so the filter is written once and the wire, the replay
//! buffer, the snapshot and the on-disk log all lighten together. An adapter
//! stays free to translate its agent faithfully; what leaves the daemon is
//! the overview.
//!
//! Where an agent's protocol carries a ready-made overview, the adapter has
//! already put it in the identifying field this filter reads (Codex's
//! reasoning summary is the reasoning text; Claude's Bash `description` is
//! explicit overview prose). Every tool becomes `Overview`: its final header
//! is at most [`SUMMARY_CHARS`], input is one [`TOOL_LINE_CHARS`]-character
//! line, and output keeps only its bounded first two and last two lines.

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail, ToolKind};

/// Agent prose stays short; the final header may use the remaining room for input.
pub const OVERVIEW_CHARS: usize = 48;
pub const SUMMARY_CHARS: usize = 64;
pub const TOOL_LINE_CHARS: usize = 64;
pub const REASONING_CHARS: usize = 24;

/// One line, at most `max` characters, with an ellipsis where text was cut.
///
/// Characters, not bytes: a thinking block is as likely to be Chinese as
/// English, and cutting mid-codepoint produces mojibake in the one place
/// meant to be readable.
pub fn shorten(text: &str, max: usize) -> String {
    // The first line that says anything. A reasoning block opens with blank
    // lines often enough that taking line one verbatim would show nothing.
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    if max == 0 {
        return String::new();
    }
    if line.chars().count() <= max {
        return line.to_string();
    }
    let mut taken: String = line.chars().take(max - 1).collect();
    taken.push('…');
    taken
}

fn one_line(text: &str, max: usize) -> String {
    clip(&text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

/// `pub(crate)`: also used by `session::rounds`'s trunk overview synthesis,
/// which wants the same character-counted clipping as everything else here.
pub(crate) fn clip(text: &str, max: usize) -> String {
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

/// The first two and last two physical lines, with every retained line bounded.
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

fn header(provided: &str, input: &str, fallback: &str) -> String {
    let input = one_line(input, TOOL_LINE_CHARS);
    let provided = one_line(&useful_label(provided), OVERVIEW_CHARS);
    let fallback = useful_label(fallback);
    if provided.is_empty() {
        return clip(first_nonempty(&[&input, &fallback]), SUMMARY_CHARS);
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

/// A label worth putting on a row. Generic tool verbs and punctuation-only
/// titles are not — the icon already says "a tool".
pub fn useful_label(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() || is_generic_tool_name(text) {
        return String::new();
    }
    if text
        .chars()
        .all(|ch| !ch.is_alphanumeric() && ch != '_' && ch != '-' && ch != '.' && ch != '/')
    {
        return String::new();
    }
    text.to_string()
}

fn is_generic_tool_name(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "tool"
            | "read"
            | "read file"
            | "write"
            | "write file"
            | "edit"
            | "edit file"
            | "find"
            | "grep"
            | "glob"
            | "search"
            | "bash"
            | "shell"
            | "execute"
            | "exec"
            | "ls"
            | "list"
            | "fetch"
            | "web fetch"
            | "websearch"
            | "web search"
            | "unknown"
    )
}

/// The overview of an event, when the event carries detail worth shedding.
///
/// Events that are already small pass through unchanged rather than paying
/// for a clone of everything: turn boundaries, permissions, titles and text
/// deltas (which belong to the reply itself, not to thinking or tools).
pub fn condense_event(event: &SessionEvent) -> SessionEvent {
    match event {
        SessionEvent::Item { turn_id, item } => SessionEvent::Item {
            turn_id: turn_id.clone(),
            item: condense_item(item),
        },
        SessionEvent::ItemDelta {
            turn_id,
            item_id,
            delta:
                ItemDelta::ToolStatus {
                    status,
                    detail,
                    images,
                },
        } => SessionEvent::ItemDelta {
            turn_id: turn_id.clone(),
            item_id: item_id.clone(),
            delta: ItemDelta::ToolStatus {
                status: *status,
                detail: detail.as_ref().map(|detail| condense_detail(detail, None)),
                images: images.clone(),
            },
        },
        other => other.clone(),
    }
}

/// The overview of one timeline item.
pub fn condense_item(item: &TimelineItem) -> TimelineItem {
    match item {
        TimelineItem::Reasoning { id, text, .. } => TimelineItem::Reasoning {
            id: id.clone(),
            text: shorten(text, REASONING_CHARS),
            received_at_ms: item.received_at_ms(),
        },
        TimelineItem::ToolCall {
            id,
            name,
            status,
            detail,
            images,
            started_at_ms,
            finished_at_ms,
        } => TimelineItem::ToolCall {
            id: id.clone(),
            name: shorten(name, OVERVIEW_CHARS),
            status: *status,
            detail: condense_detail(detail, Some(name)),
            images: images.clone(),
            started_at_ms: *started_at_ms,
            finished_at_ms: *finished_at_ms,
        },
        other => other.clone(),
    }
}

/// Converts every adapter-specific tool shape into the only shape sessions retain.
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
            (
                kind_from_name(fallback_name.unwrap_or_default()),
                provided,
                input,
                output,
            )
        }
    };
    let fallback = fallback_name.unwrap_or_default();
    let heading = header(&provided, &input, fallback);
    ToolCallDetail::Overview {
        tool_kind: kind,
        // A call whose name, input and summary are all empty or generic (ACP
        // agents may send no title at all) still gets a tell-apart label.
        overview: if heading.is_empty() {
            kind_label(kind).to_string()
        } else {
            heading
        },
        input: one_line(&input, TOOL_LINE_CHARS),
        output: output_excerpt(&output),
    }
}

/// Last-resort overview for a tool call that carries no words of its own.
/// Mirrors the workbench's kind labels so a bare blob line still says what
/// happened.
fn kind_label(kind: ToolKind) -> &'static str {
    match kind {
        ToolKind::Shell => "执行命令",
        ToolKind::Read => "读取文件",
        ToolKind::Write => "写入文件",
        ToolKind::Edit => "编辑文件",
        ToolKind::Search => "搜索",
        ToolKind::Fetch => "访问网络",
        ToolKind::Plan => "计划",
        ToolKind::SubAgent => "子 Agent",
        ToolKind::Mcp => "外部工具",
        ToolKind::Other => "工具",
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

    fn overview(detail: ToolCallDetail) -> (String, String, String) {
        match condense_detail(&detail, Some("fallback")) {
            ToolCallDetail::Overview {
                overview,
                input,
                output,
                ..
            } => (overview, input, output),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn reasoning_is_one_line_of_at_most_24_characters() {
        assert_eq!(shorten("short", 24), "short");
        assert_eq!(shorten("\n\n  first line\nsecond", 24), "first line");
        assert_eq!(
            shorten("a command that runs far past the limit", 24),
            "a command that runs far…"
        );
        // Exactly at the limit is not cut; one past it is.
        let exact: String = "字".repeat(24);
        assert_eq!(shorten(&exact, 24), exact);
        let over: String = "字".repeat(25);
        let shortened = shorten(&over, 24);
        assert_eq!(shortened, format!("{}…", "字".repeat(23)));
        assert_eq!(shortened.chars().count(), 24);
    }

    #[test]
    fn thinking_is_cut_to_its_first_sentence() {
        let item = TimelineItem::Reasoning {
            id: "r".into(),
            text: "Let me think about this problem carefully and consider every option".into(),
            received_at_ms: None,
        };
        match condense_item(&item) {
            TimelineItem::Reasoning { text, .. } => {
                assert_eq!(text, "Let me think about this…");
                assert!(text.chars().count() <= REASONING_CHARS);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_shell_call_keeps_one_input_line_and_four_output_lines() {
        let item = TimelineItem::ToolCall {
            id: "c".into(),
            name: "Shell".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Shell {
                command: "ls".into(),
                output: "thousands of lines\n".repeat(100),
                exit_code: Some(3),
            },
            images: vec![],
            started_at_ms: None,
            finished_at_ms: None,
        };
        match condense_item(&item) {
            TimelineItem::ToolCall { detail, .. } => {
                let ToolCallDetail::Overview {
                    overview,
                    input,
                    output,
                    tool_kind,
                } = detail
                else {
                    panic!("unexpected detail")
                };
                assert_eq!(overview, "ls");
                assert_eq!(input, "ls");
                assert_eq!(tool_kind, ToolKind::Shell);
                assert_eq!(output.lines().count(), 5);
                assert!(output
                    .lines()
                    .all(|line| line.chars().count() <= TOOL_LINE_CHARS));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn every_tool_shape_becomes_an_overview_with_bounded_fields() {
        for detail in [
            ToolCallDetail::Edit {
                path: "src/main.rs".into(),
                diff: "@@ huge @@".into(),
            },
            ToolCallDetail::Read {
                path: "src/main.rs".into(),
                content: "the whole file".into(),
                truncated: true,
            },
            ToolCallDetail::Write {
                path: "src/main.rs".into(),
                content: "the whole file".into(),
            },
        ] {
            let (overview, input, output) = overview(detail);
            assert!(overview.chars().count() <= SUMMARY_CHARS, "{overview:?}");
            assert!(input.chars().count() <= TOOL_LINE_CHARS, "{input:?}");
            assert!(output
                .lines()
                .all(|line| line.chars().count() <= TOOL_LINE_CHARS));
        }
    }

    #[test]
    fn plans_have_no_unbounded_exception() {
        let detail = ToolCallDetail::Plan {
            markdown: "## 步骤\n\na plan someone must read before approving".repeat(10),
        };
        let (overview, input, output) = overview(detail);
        assert!(overview.chars().count() <= SUMMARY_CHARS);
        assert!(input.chars().count() <= TOOL_LINE_CHARS);
        assert!(output.is_empty());
    }

    #[test]
    fn an_agent_provided_overview_wins_for_unknown_tools() {
        let detail = ToolCallDetail::Unknown {
            raw: serde_json::json!({
                "overview": "agent supplied overview that is much too long",
                "input": "input value",
                "output": "output value"
            }),
        };
        let (overview, input, output) = overview(detail);
        assert!(overview.starts_with("agent supplied overview"));
        assert!(overview.chars().count() <= SUMMARY_CHARS);
        assert!(overview.ends_with("input value"));
        assert_eq!(input, "input value");
        assert_eq!(output, "output value");
    }

    #[test]
    fn an_explicit_overview_uses_48_characters_then_fills_the_64_character_header() {
        let provided = "概".repeat(60);
        let input = "入".repeat(60);
        let title = header(&provided, &input, "fallback");
        assert_eq!(title.chars().count(), SUMMARY_CHARS);
        assert!(title.starts_with(&format!("{}… · ", "概".repeat(OVERVIEW_CHARS - 1))));
        assert!(title.ends_with('…'));
    }

    #[test]
    fn missing_overview_uses_the_input_directly() {
        let title = header("", &"入".repeat(80), "fallback");
        assert_eq!(title.chars().count(), SUMMARY_CHARS);
        assert!(!title.contains(" · "));
    }

    #[test]
    fn a_sub_agent_keeps_only_its_overview_input_and_last_output() {
        let detail = ToolCallDetail::SubAgent {
            agent: "Explore".into(),
            prompt: "find the thing".into(),
            items: vec![TimelineItem::AssistantMessage {
                id: "s".into(),
                text: "nested work".into(),
                received_at_ms: None,
            }],
        };
        assert_eq!(
            overview(detail),
            (
                "Explore · find the thing".into(),
                "find the thing".into(),
                "nested work".into()
            )
        );
    }

    #[test]
    fn tool_status_deltas_are_condensed_and_small_events_pass_through() {
        let delta = SessionEvent::ItemDelta {
            turn_id: "t".into(),
            item_id: "c".into(),
            delta: ItemDelta::ToolStatus {
                status: ToolStatus::Ok,
                detail: Some(ToolCallDetail::Shell {
                    command: "make".into(),
                    output: "a wall of compiler output".into(),
                    exit_code: Some(0),
                }),
                images: vec![],
            },
        };
        match condense_event(&delta) {
            SessionEvent::ItemDelta {
                delta: ItemDelta::ToolStatus { detail, .. },
                ..
            } => match detail.expect("the detail is kept, condensed") {
                ToolCallDetail::Overview {
                    overview,
                    input,
                    output,
                    tool_kind,
                } => {
                    assert_eq!(overview, "make");
                    assert_eq!(input, "make");
                    assert_eq!(output, "a wall of compiler output");
                    assert_eq!(tool_kind, ToolKind::Shell);
                }
                other => panic!("unexpected {other:?}"),
            },
            other => panic!("unexpected {other:?}"),
        }

        // A reply's own text is content, not detail: untouched.
        let text = SessionEvent::ItemDelta {
            turn_id: "t".into(),
            item_id: "m".into(),
            delta: ItemDelta::Text {
                delta: "a long piece of the actual answer, which stays whole".into(),
            },
        };
        assert_eq!(condense_event(&text), text);
    }

    #[test]
    fn a_read_without_a_path_does_not_use_file_contents_as_the_overview() {
        match condense_detail(
            &ToolCallDetail::Read {
                path: String::new(),
                content: "---\nname: genethub-worktree-router\n".into(),
                truncated: false,
            },
            Some("Read File"),
        ) {
            ToolCallDetail::Overview {
                overview,
                input,
                output,
                ..
            } => {
                // No path and a generic name: the kind label stands in, and
                // the file contents stay out of the overview.
                assert_eq!(overview, "读取文件");
                assert_eq!(input, "");
                assert!(output.starts_with("---"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_generic_tool_name_is_not_an_overview() {
        assert_eq!(header("", "", "tool"), "");
        assert_eq!(header("", "", "Read File"), "");
        assert_eq!(header("", "src/main.rs", "Read File"), "src/main.rs");
    }

    #[test]
    fn unknown_raw_json_is_not_the_overview() {
        match condense_detail(
            &ToolCallDetail::Unknown {
                raw: serde_json::json!({"rawOutput": {"totalFiles": 4}}),
            },
            Some("tool"),
        ) {
            ToolCallDetail::Overview {
                overview,
                input,
                output,
                ..
            } => {
                // Raw JSON never leaks into the overview; a fully generic
                // call falls back to the plain kind label.
                assert_eq!(overview, "工具");
                assert_eq!(input, "");
                assert_eq!(output, "");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
