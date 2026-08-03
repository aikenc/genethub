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
//! the shell command's one-liner). Every tool becomes `Overview`, with its
//! overview, input and output independently capped at [`OVERVIEW_CHARS`].

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail};

/// The hard limit for every retained tool/reasoning string.
pub const OVERVIEW_CHARS: usize = 24;

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

/// The overview of one timeline item.
pub fn condense_item(item: &TimelineItem) -> TimelineItem {
    match item {
        TimelineItem::Reasoning { id, text } => TimelineItem::Reasoning {
            id: id.clone(),
            text: shorten(text, OVERVIEW_CHARS),
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

/// Converts every adapter-specific tool shape into the only shape sessions
/// retain. No field in the returned value can exceed 24 Unicode characters.
fn condense_detail(detail: &ToolCallDetail, fallback_name: Option<&str>) -> ToolCallDetail {
    let (provided, input, output) = match detail {
        ToolCallDetail::Overview {
            overview,
            input,
            output,
        } => (overview.clone(), input.clone(), output.clone()),
        ToolCallDetail::Shell {
            command, output, ..
        } => (command.clone(), command.clone(), output.clone()),
        ToolCallDetail::Read { path, content, .. } => (path.clone(), path.clone(), content.clone()),
        ToolCallDetail::Write { path, content } => (path.clone(), path.clone(), content.clone()),
        ToolCallDetail::Edit { path, diff } => (path.clone(), path.clone(), diff.clone()),
        ToolCallDetail::Search { query, matches } => {
            let output = matches
                .first()
                .map(|found| {
                    let line = found
                        .line
                        .map(|line| format!(":{line}"))
                        .unwrap_or_default();
                    format!("{}{line} {}", found.path, found.preview)
                })
                .unwrap_or_default();
            (query.clone(), query.clone(), output)
        }
        ToolCallDetail::Fetch { url, summary } => (url.clone(), url.clone(), summary.clone()),
        ToolCallDetail::Plan { markdown } => (markdown.clone(), markdown.clone(), String::new()),
        ToolCallDetail::SubAgent {
            agent,
            prompt,
            items,
        } => {
            let output = items
                .iter()
                .rev()
                .find_map(item_overview)
                .unwrap_or_default();
            let provided = if agent.trim().is_empty() {
                prompt
            } else {
                agent
            };
            (provided.clone(), prompt.clone(), output)
        }
        ToolCallDetail::Unknown { raw } => {
            let input = raw_field(raw, &["input", "arguments"]);
            let output = raw_field(raw, &["output", "result"]);
            let provided = raw_field(raw, &["overview", "summary", "description", "title"]);
            let encoded = serde_json::to_string(raw).unwrap_or_default();
            (
                first_nonempty(&[&provided, &input, &output, &encoded]).to_string(),
                first_nonempty(&[&input, &encoded]).to_string(),
                output,
            )
        }
    };
    let fallback = fallback_name.unwrap_or_default();
    let overview = first_nonempty(&[&provided, &input, &output, fallback]);
    ToolCallDetail::Overview {
        overview: shorten(overview, OVERVIEW_CHARS),
        input: shorten(&input, OVERVIEW_CHARS),
        output: shorten(&output, OVERVIEW_CHARS),
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
            } => (overview, input, output),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_overview_is_one_line_of_at_most_24_characters() {
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
        };
        match condense_item(&item) {
            TimelineItem::Reasoning { text, .. } => {
                assert_eq!(text, "Let me think about this…");
                assert!(text.chars().count() <= OVERVIEW_CHARS);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_shell_call_keeps_only_three_24_character_strings() {
        let item = TimelineItem::ToolCall {
            id: "c".into(),
            name: "Shell".into(),
            status: ToolStatus::Ok,
            detail: ToolCallDetail::Shell {
                command: "ls".into(),
                output: "thousands of lines\n".repeat(100),
                exit_code: Some(3),
            },
        };
        match condense_item(&item) {
            TimelineItem::ToolCall { detail, .. } => {
                let ToolCallDetail::Overview {
                    overview,
                    input,
                    output,
                } = detail
                else {
                    panic!("unexpected detail")
                };
                assert_eq!(overview, "ls");
                assert_eq!(input, "ls");
                assert!(output.chars().count() <= OVERVIEW_CHARS);
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
            for field in [overview, input, output] {
                assert!(field.chars().count() <= OVERVIEW_CHARS, "{field:?}");
            }
        }
    }

    #[test]
    fn plans_have_no_unbounded_exception() {
        let detail = ToolCallDetail::Plan {
            markdown: "## 步骤\n\na plan someone must read before approving".repeat(10),
        };
        let (overview, input, output) = overview(detail);
        assert!(overview.chars().count() <= OVERVIEW_CHARS);
        assert!(input.chars().count() <= OVERVIEW_CHARS);
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
        assert_eq!(overview.chars().count(), OVERVIEW_CHARS);
        assert_eq!(input, "input value");
        assert_eq!(output, "output value");
    }

    #[test]
    fn a_sub_agent_keeps_only_its_overview_input_and_last_output() {
        let detail = ToolCallDetail::SubAgent {
            agent: "Explore".into(),
            prompt: "find the thing".into(),
            items: vec![TimelineItem::AssistantMessage {
                id: "s".into(),
                text: "nested work".into(),
            }],
        };
        assert_eq!(
            overview(detail),
            (
                "Explore".into(),
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
                } => {
                    assert_eq!(overview, "make");
                    assert_eq!(input, "make");
                    assert_eq!(output, "a wall of compiler outp…");
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
}
