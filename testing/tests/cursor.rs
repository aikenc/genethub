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

use genehub_proto::{Reply, Request};
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

    let cursor = match journey.client.call(Request::AgentList).await {
        Ok(Reply::Agents(agents)) => agents.into_iter().find(|agent| agent.id == "cursor"),
        _ => None,
    };
    if let Some(cursor) = cursor {
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
                session_id: session.clone(),
                model_id,
            })
            .await
        {
            eprintln!("cursor set_model failed in this environment: {error}");
        }
    }

    journey
        .send(&session, PROMPT)
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert_normalized_reply(&events, PROMPT);

    journey.finish().await;
}
