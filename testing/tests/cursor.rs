//! The same journey, driven through the Cursor CLI, spoken as ACP
//! (`cursor-agent acp`) — the protocol that CLI publishes for exactly this
//! kind of embedding (`packages/daemon-core/src/session/acp.rs`).
//!
//! There is no pointing Cursor at the mock: its CLI picks the model from the
//! account it is logged into, and offers no backend address to override, so
//! this journey only runs in real mode (`docs/testing.md` §2.2), on a machine
//! where `cursor-agent` is installed and logged in. That is the same deal as
//! Codex (`docs/third-party-agents.md` §4): the login belongs to the CLI, not
//! to us.
//!
//! What this pins down that the ACP unit tests cannot: the binary we probe
//! for is the binary that starts, the ACP handshake we open is one the real
//! CLI answers, and a turn comes back through the normalized timeline.

use std::sync::Mutex;
use std::time::Instant;

use genehub_proto::{Reply, Request, SessionEvent, TimelineItem};
use genehub_testing::{assert_normalized_reply, binary_on_path, real_only, Journey};

macro_rules! needs_cursor_agent {
    ($journey:expr) => {
        if !binary_on_path("cursor-agent") {
            eprintln!(
                "skipping {}: the `cursor-agent` CLI is not on PATH; \
                 `curl https://cursor.com/install -fsS | bash` to cover this adapter",
                module_path!()
            );
            $journey.finish().await;
            return;
        }
    };
}

/// Points `session` at one of Cursor's own models. The journey's real-mode
/// default is the model the built-in Agent talks to, which Cursor has never
/// heard of, and a session left on it answers from whichever model the account
/// happens to default to.
async fn pick_a_cursor_model(journey: &Journey, session: &str) {
    let Ok(Reply::Agents(agents)) = journey.client.call(Request::AgentList).await else {
        return;
    };
    let Some(cursor) = agents.into_iter().find(|agent| agent.id == "cursor") else {
        return;
    };
    let model_id = cursor
        .catalog
        .models
        .iter()
        .find(|model| model.id.contains("composer-2.5[fast=true]"))
        .or_else(|| cursor.catalog.models.first())
        .map(|model| model.id.clone())
        .unwrap_or_else(|| "composer-2.5[fast=true]".into());
    if let Err(error) = journey
        .client
        .call(Request::SessionSetModel {
            session_id: session.to_string(),
            model_id,
        })
        .await
    {
        eprintln!("cursor set_model failed in this environment: {error}");
    }
}

#[tokio::test]
async fn cursor_reaches_the_same_timeline_as_the_built_in_agent() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_cursor_agent!(journey);

    // Models and modes come from ACP `session/new`; pick one from the catalog
    // when Cursor is present, otherwise keep the account default.
    const PROMPT: &str = "Reply with exactly one word: pong";
    let session = journey
        .session("cursor")
        .await
        .expect("a session opens on Cursor");

    pick_a_cursor_model(&journey, &session).await;

    journey
        .send(&session, PROMPT)
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert_normalized_reply(&events, PROMPT);

    journey.finish().await;
}

/// A tool call has to reach a subscriber while the Agent is still working.
///
/// Ordering alone cannot show this: a daemon that buffered the whole turn and
/// flushed it at the end would deliver the same sequence. What separates the
/// two is when the bytes arrive, so this measures the gap between the first
/// tool call and the end of the turn. A real Cursor turn that edits a file
/// spends seconds between those two points; a buffered one closes the gap to
/// the width of a single flush.
#[tokio::test]
async fn a_cursor_tool_call_is_visible_while_the_turn_is_still_running() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_cursor_agent!(journey);

    const PROMPT: &str = "Create a file named ping.txt in the current working \
         directory whose only contents are the word pong, using your file tools. \
         Then reply with exactly: done";
    let session = journey
        .session("cursor")
        .await
        .expect("a session opens on Cursor");
    pick_a_cursor_model(&journey, &session).await;
    journey
        .send(&session, PROMPT)
        .await
        .expect("prompt accepted");

    let sent = Instant::now();
    let announced = journey
        .client
        .wait_for(|event| {
            matches!(
                event,
                SessionEvent::Item {
                    item: TimelineItem::ToolCall { .. },
                    ..
                }
            )
        })
        .await
        .expect("a tool call reaches the subscriber");
    let at_tool_call = sent.elapsed();
    let SessionEvent::Item {
        item: TimelineItem::ToolCall { id, name, .. },
        ..
    } = &announced
    else {
        unreachable!("the predicate selected a tool call");
    };
    let (announced_id, announced_name) = (id.clone(), name.clone());

    let updates = Mutex::new(Vec::new());
    journey
        .client
        .wait_for(|event| match event {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { id, name, .. },
                ..
            } => {
                if *id == announced_id {
                    updates.lock().expect("lock").push(name.clone());
                }
                false
            }
            SessionEvent::TurnCompleted { .. }
            | SessionEvent::TurnFailed { .. }
            | SessionEvent::TurnCanceled { .. } => true,
            _ => false,
        })
        .await
        .expect("the turn ends");
    let at_turn_end = sent.elapsed();

    let lead = at_turn_end.saturating_sub(at_tool_call);
    assert!(
        lead.as_millis() >= 250,
        "the tool call arrived {}ms after the prompt and the turn ended {}ms after it, \
         a lead of only {}ms: the timeline was flushed at the end of the turn rather \
         than streamed while the Agent worked",
        at_tool_call.as_millis(),
        at_turn_end.as_millis(),
        lead.as_millis()
    );

    // Progress on a tool call arrives as frames carrying only what changed, so
    // a subscriber watching live must still see the call it was introduced to.
    let updates = updates.into_inner().expect("lock");
    assert!(
        updates.iter().all(|name| *name == announced_name),
        "the tool call was announced as {announced_name:?} and then re-rendered \
         as {updates:?} while the turn was still running"
    );

    journey.finish().await;
}
