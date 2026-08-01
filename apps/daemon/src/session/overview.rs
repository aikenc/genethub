//! One-line overviews, applied at the access layer.
//!
//! Tool calls and thinking are where a session's weight lives: a shell
//! command's whole output, a file's whole content, a diff, the raw frame of a
//! tool nobody has a renderer for, and a thinking block that streams one
//! message per token. None of that is what a person scanning the timeline is
//! looking for — they want the one sentence that says what the agent did.
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
//! already put it in the field this filter keeps (Codex's reasoning summary
//! is the reasoning text; Claude's Bash `description` is the shell command's
//! one-liner). Everything else is cut to [`OVERVIEW_CHARS`].
//!
//! The exception is [`ToolCallDetail::Plan`]: a plan is not detail, it is the
//! thing a person reads end to end before approving it, so it passes through
//! whole.

use genehub_proto::{ItemDelta, SessionEvent, TimelineItem, ToolCallDetail};

/// The longest an overview may run, in characters — about one sentence, and
/// short enough that a card's header never wraps.
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
    let mut taken: String = line.chars().take(max).collect();
    if line.chars().count() > max {
        taken.push('…');
    }
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
                detail: detail.as_ref().map(condense_detail),
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
            name: name.clone(),
            status: *status,
            detail: condense_detail(detail),
        },
        other => other.clone(),
    }
}

/// The overview of a tool call: what it was asked to do, never what came back.
///
/// The identifying one-liner is kept per shape — the command, the path, the
/// query — and the payload it produced is shed. `exit_code` survives because
/// it is one integer and the difference between "ran" and "failed".
fn condense_detail(detail: &ToolCallDetail) -> ToolCallDetail {
    match detail {
        ToolCallDetail::Shell {
            command, exit_code, ..
        } => ToolCallDetail::Shell {
            command: shorten(command, OVERVIEW_CHARS),
            output: String::new(),
            exit_code: *exit_code,
        },
        ToolCallDetail::Read { path, .. } => ToolCallDetail::Read {
            path: path.clone(),
            content: String::new(),
            truncated: false,
        },
        ToolCallDetail::Write { path, .. } => ToolCallDetail::Write {
            path: path.clone(),
            content: String::new(),
        },
        ToolCallDetail::Edit { path, .. } => ToolCallDetail::Edit {
            path: path.clone(),
            diff: String::new(),
        },
        ToolCallDetail::Search { query, .. } => ToolCallDetail::Search {
            query: shorten(query, OVERVIEW_CHARS),
            matches: Vec::new(),
        },
        ToolCallDetail::Fetch { url, summary } => ToolCallDetail::Fetch {
            url: url.clone(),
            summary: shorten(summary, OVERVIEW_CHARS),
        },
        // Whole, on purpose — see the module doc.
        ToolCallDetail::Plan { .. } => detail.clone(),
        ToolCallDetail::SubAgent { agent, prompt, .. } => ToolCallDetail::SubAgent {
            agent: agent.clone(),
            prompt: shorten(prompt, OVERVIEW_CHARS),
            items: Vec::new(),
        },
        // The whole frame, kept "just in case", is the single heaviest thing
        // any adapter sends. The card keeps the tool's name and status; the
        // JSON is the detail being filtered.
        ToolCallDetail::Unknown { .. } => ToolCallDetail::Unknown {
            raw: serde_json::Value::Null,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::ToolStatus;

    #[test]
    fn an_overview_is_one_line_of_at_most_24_characters() {
        assert_eq!(shorten("short", 24), "short");
        assert_eq!(shorten("\n\n  first line\nsecond", 24), "first line");
        assert_eq!(
            shorten("a command that runs far past the limit", 24),
            "a command that runs far …"
        );
        // Exactly at the limit is not cut; one past it is.
        let exact: String = "字".repeat(24);
        assert_eq!(shorten(&exact, 24), exact);
        let over: String = "字".repeat(25);
        assert_eq!(shorten(&over, 24), format!("{}…", "字".repeat(24)));
    }

    #[test]
    fn thinking_is_cut_to_its_first_sentence() {
        let item = TimelineItem::Reasoning {
            id: "r".into(),
            text: "Let me think about this problem carefully and consider every option".into(),
        };
        match condense_item(&item) {
            TimelineItem::Reasoning { text, .. } => {
                assert_eq!(text, "Let me think about this …");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_shell_call_keeps_the_command_and_code_and_sheds_the_output() {
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
            TimelineItem::ToolCall {
                detail:
                    ToolCallDetail::Shell {
                        command,
                        output,
                        exit_code,
                    },
                ..
            } => {
                assert_eq!(command, "ls");
                assert!(output.is_empty(), "the output is the detail");
                assert_eq!(exit_code, Some(3));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn edits_reads_and_writes_keep_the_path_and_shed_the_payload() {
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
            let condensed = condense_detail(&detail);
            let size = serde_json::to_string(&condensed).unwrap().len();
            assert!(size < 120, "the payload survived: {condensed:?}");
        }
    }

    #[test]
    fn a_plan_passes_through_whole() {
        let detail = ToolCallDetail::Plan {
            markdown: "## 步骤\n\na plan someone must read before approving".repeat(10),
        };
        assert_eq!(condense_detail(&detail), detail);
    }

    #[test]
    fn an_unknown_tools_raw_frame_is_dropped_but_the_card_stays() {
        let detail = ToolCallDetail::Unknown {
            raw: serde_json::json!({ "everything": "the agent said", "more": [1, 2, 3] }),
        };
        match condense_detail(&detail) {
            ToolCallDetail::Unknown { raw } => assert!(raw.is_null()),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_sub_agent_sheds_its_nested_steps() {
        let detail = ToolCallDetail::SubAgent {
            agent: "Explore".into(),
            prompt: "find the thing".into(),
            items: vec![TimelineItem::AssistantMessage {
                id: "s".into(),
                text: "nested work".into(),
            }],
        };
        match condense_detail(&detail) {
            ToolCallDetail::SubAgent { items, .. } => assert!(items.is_empty()),
            other => panic!("unexpected {other:?}"),
        }
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
                ToolCallDetail::Shell { output, .. } => assert!(output.is_empty()),
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
