//! Shared assertions for the provider-specific journeys under `testing/tests`
//! (`opencode.rs`, `claude.rs`, and whatever adapter comes next).
//!
//! Every one of those journeys ends up checking the same handful of things
//! once its own CLI-specific setup (config file, env vars, `--resume`, …) is
//! out of the way: did the turn actually finish, did the reply arrive as
//! normalized timeline text rather than something only that CLI's own UI
//! could render, and did the adapter echo the prompt back as if it were the
//! answer. Centralizing that here means a fix to one always fixes all of
//! them, instead of the same bug living happily in whichever journey nobody
//! re-reads (`docs/testing.md` §2.2, "第三方 agent 旅程").

use genehub_proto::{SessionEvent, TimelineItem};

use crate::client::EventsExt;

/// Asserts that `events` is a turn that completed with a non-empty reply
/// belonging to the same timeline as the user's prompt, and that the reply is
/// not simply the prompt echoed back. Returns the reply text for any
/// additional, agent-specific assertions the caller wants to make.
pub fn assert_normalized_reply(events: &[SessionEvent], prompt: &str) -> String {
    assert!(
        events.completed(),
        "the turn should complete; saw {:?}",
        events.failure()
    );
    let reply = events.assistant_text();
    assert!(
        !reply.trim().is_empty(),
        "a third-party agent's reply must arrive as normalized timeline text, \
         not as something only its own UI could render"
    );
    assert!(
        !reply.contains(prompt),
        "the prompt was replayed as the answer: {reply:?}"
    );
    assert!(
        events
            .items()
            .iter()
            .any(|item| matches!(item, TimelineItem::UserMessage { .. })),
        "the prompt belongs to the turn whichever agent served it"
    );
    reply
}

/// True if `name` resolves on `PATH`. Every provider journey skips itself
/// instead of failing when its CLI is not installed; this is the one line of
/// logic behind that check, so each journey's own macro is one line calling
/// this rather than its own copy of `PATH` splitting.
pub fn binary_on_path(name: &str) -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| dir.join(name).is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{TurnError, TurnErrorCode, Usage};

    fn completed(items: Vec<TimelineItem>) -> Vec<SessionEvent> {
        let mut events: Vec<SessionEvent> = items
            .into_iter()
            .map(|item| SessionEvent::Item {
                turn_id: "t1".into(),
                item,
            })
            .collect();
        events.push(SessionEvent::TurnCompleted {
            turn_id: "t1".into(),
            usage: Usage::default(),
            fork_checkpoint: None,
        });
        events
    }

    #[test]
    fn a_normal_reply_passes_and_is_returned() {
        let events = completed(vec![
            TimelineItem::UserMessage {
                id: "u1".into(),
                text: "Say hi".into(),
                attachments: Vec::new(),
            },
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "hi there".into(),
            },
        ]);
        assert_eq!(assert_normalized_reply(&events, "Say hi"), "hi there");
    }

    #[test]
    #[should_panic(expected = "the turn should complete")]
    fn an_unfinished_turn_fails_the_assertion() {
        let events = vec![SessionEvent::TurnFailed {
            turn_id: "t1".into(),
            error: TurnError {
                code: TurnErrorCode::Upstream,
                message: "boom".into(),
            },
        }];
        assert_normalized_reply(&events, "Say hi");
    }

    #[test]
    #[should_panic(expected = "replayed as the answer")]
    fn an_echoed_prompt_fails_the_assertion() {
        let events = completed(vec![
            TimelineItem::UserMessage {
                id: "u1".into(),
                text: "Say hi".into(),
                attachments: Vec::new(),
            },
            TimelineItem::AssistantMessage {
                id: "a1".into(),
                text: "Say hi".into(),
            },
        ]);
        assert_normalized_reply(&events, "Say hi");
    }

    #[test]
    fn a_binary_that_does_not_exist_is_not_on_path() {
        assert!(!binary_on_path("genehub-definitely-not-a-real-binary"));
    }
}
