//! The same journey, driven through a third-party agent.
//!
//! OpenCode is the adapter that does not look like the others: an HTTP server
//! with a separate event stream instead of a child process on stdio. Running a
//! real one here is the only way to know the normalized layer is an abstraction
//! rather than a rename of the built-in agent's transport
//! (`docs/architecture.md` §3.3).
//!
//! Everything except the model is real, as everywhere else: OpenCode is the
//! genuine binary, and it talks to the same backend the built-in agent uses.

use genehub_testing::{assert_normalized_reply, binary_on_path, EventsExt, Journey, Turn};
use serde_json::json;

/// OpenCode is not a dependency of this project, so a machine without it runs
/// everything else. Saying why beats a case that silently disappears
/// (`docs/testing.md` §2.2).
macro_rules! needs_opencode {
    ($journey:expr) => {
        if !binary_on_path("opencode") {
            eprintln!(
                "skipping {}: OpenCode is not on PATH; install it to cover the adapter",
                module_path!()
            );
            $journey.finish().await;
            return;
        }
    };
}

#[tokio::test]
async fn a_third_party_agent_reaches_the_same_timeline_as_the_built_in_one() {
    let journey = Journey::start().await.expect("journey starts");
    needs_opencode!(journey);
    point_opencode_at_our_model(&journey);
    // OpenCode spends a call on naming the thread before it answers, so the
    // script needs one more reply than the visible turn suggests.
    script(&journey, &["A title", "hello from the third-party agent"]).await;
    const PROMPT: &str = "Say hello.";

    let session = journey
        .session_with_model(
            "opencode",
            &format!("{PROVIDER}/{}", journey.model.bare_id()),
        )
        .await
        .expect("a session opens on OpenCode");
    journey
        .send(&session, PROMPT)
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    // OpenCode streams the prompt back as part of the conversation, which is
    // exactly the echo case this shared assertion exists to catch.
    assert_normalized_reply(&events, PROMPT);

    journey.finish().await;
}

#[tokio::test]
async fn two_agents_run_side_by_side_without_leaking_into_each_other() {
    let journey = Journey::start().await.expect("journey starts");
    needs_opencode!(journey);
    point_opencode_at_our_model(&journey);
    script(&journey, &["A title", "third party", "built in"]).await;

    let third_party = journey
        .session_with_model(
            "opencode",
            &format!("{PROVIDER}/{}", journey.model.bare_id()),
        )
        .await
        .expect("a session opens on OpenCode");
    let built_in = journey.session("genet").await.expect("session opens");

    // Both turns are in flight at once, which is the only arrangement where
    // shared state between two different agents would show up.
    journey
        .send(&third_party, "Say something.")
        .await
        .expect("prompt accepted");
    journey
        .send(&built_in, "Say something.")
        .await
        .expect("prompt accepted");
    let turns = journey
        .client
        .drain_turns(&[&third_party, &built_in])
        .await
        .expect("both turns end");

    for (session, events) in &turns {
        assert!(
            events.completed(),
            "session {session} did not complete: {:?}",
            events.failure()
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| matches!(event, genehub_proto::SessionEvent::TurnStarted { .. }))
                .count(),
            1,
            "session {session} saw another session's turn"
        );
        assert!(
            !events.assistant_text().trim().is_empty(),
            "session {session} produced no reply"
        );
    }

    journey.finish().await;
}

/// The provider name OpenCode is told to use. It is ours, not one of the
/// built-in ones, so the journey controls where the tokens actually go.
const PROVIDER: &str = "journey";

/// Writes the OpenCode config into the workspace, pointing it at whichever
/// model backs this run. In mock mode nothing leaves the machine; in real mode
/// it is the same endpoint and key the built-in agent got.
fn point_opencode_at_our_model(journey: &Journey) {
    let config = json!({
        "$schema": "https://opencode.ai/config.json",
        "provider": {
            PROVIDER: {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Journey",
                "options": {
                    "baseURL": journey.model.base_url,
                    "apiKey": journey.model.api_key,
                },
                "models": { journey.model.bare_id(): { "name": "Journey" } },
            }
        }
    });
    journey
        .write_file(
            "opencode.json",
            &serde_json::to_string_pretty(&config).expect("config serializes"),
        )
        .expect("writing the OpenCode config");
}

/// Queues the replies the mock will hand out, in order. A real run ignores this.
async fn script(journey: &Journey, replies: &[&str]) {
    if !journey.mode.is_mock() {
        return;
    }
    for reply in replies {
        journey.mock().reply(Turn::text(*reply)).await;
    }
}
