//! The same journey, driven through Claude Code — natively, not through the
//! `claude-agent-acp` wrapper (`apps/daemon/src/adapter/claude.rs`).
//!
//! Unlike OpenCode, Claude Code does not speak an OpenAI-compatible wire
//! format, so it cannot be pointed at the mock: DeepSeek's Anthropic-compatible
//! endpoint (`https://api.deepseek.com/anthropic`) is a real HTTP surface the
//! mock does not implement. This journey therefore only runs in real mode
//! (`docs/testing.md` §2.2).
//!
//! We do not manage how Claude Code reaches its model. The daemon only spawns
//! the `claude` binary and speaks its own `stream-json` protocol to it,
//! exactly like any other adapter; the environment variables below are Claude
//! Code's own documented way of choosing a backend, not a protocol this
//! project owns (`docs/architecture.md` §3, boundary B1).

use genehub_proto::{PermissionOutcome, Request, TimelineItem, ToolStatus};
use genehub_testing::{assert_normalized_reply, binary_on_path, real_only, EventsExt, Journey};

/// Claude Code's own Anthropic-compatible base URL for DeepSeek, per
/// DeepSeek's Agent Integrations guide. Not ours to define or version.
const DEEPSEEK_ANTHROPIC_BASE_URL: &str = "https://api.deepseek.com/anthropic";

macro_rules! needs_claude {
    ($journey:expr) => {
        if !binary_on_path("claude") {
            eprintln!(
                "skipping {}: the `claude` CLI is not on PATH; \
                 `npm install -g @anthropic-ai/claude-code` to cover this adapter",
                module_path!()
            );
            $journey.finish().await;
            return;
        }
    };
}

#[tokio::test]
async fn claude_code_reaches_the_same_timeline_as_the_built_in_agent() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    const PROMPT: &str = "Reply with exactly one word: pong";
    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .send(&session, PROMPT)
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert_normalized_reply(&events, PROMPT);

    journey.finish().await;
}

/// Going native over the ACP wrapper exists specifically to get per-tool
/// permission control back (see `adapter::claude`'s doc comment). This is the
/// one journey that actually exercises that control protocol end to end,
/// through `session.setMode` rather than answering each prompt by hand: real
/// tool execution, real permission grant, real file on disk.
#[tokio::test]
async fn accept_edits_mode_lets_a_real_tool_call_through_without_a_prompt() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .client
        .call(Request::SessionSetMode {
            session_id: session.clone(),
            mode_id: "acceptEdits".into(),
        })
        .await
        .expect("acceptEdits is a mode this adapter offers");
    journey
        .send(
            &session,
            "Create a file named greeting.txt containing exactly: hello, using your Write tool.",
        )
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    assert!(
        events.completed(),
        "acceptEdits should let the tool run without ever blocking on a \
         permission prompt nobody answers; saw {:?}",
        events.failure()
    );
    assert!(
        events.items().iter().any(|item| matches!(
            item,
            TimelineItem::ToolCall {
                status: ToolStatus::Ok,
                ..
            }
        )),
        "a tool call should have run and succeeded"
    );
    assert!(
        journey.file_exists("greeting.txt"),
        "the Write tool call should have reached the real filesystem"
    );

    journey.finish().await;
}

/// The other half of native's payoff: our own interrupt control message, not
/// just a process kill, actually reaches a running Claude Code turn.
#[tokio::test]
async fn interrupting_claude_code_ends_the_turn_as_canceled() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .send(
            &session,
            // A mechanical "count to 500" is exactly the kind of pointless,
            // repetitive request small models tend to refuse or truncate on
            // their own — which finishes the turn before the interrupt ever
            // has a chance to matter and makes the assertion below flaky for
            // reasons that have nothing to do with our interrupt plumbing.
            // A long creative-writing ask reliably keeps tokens streaming.
            "Write a very long, detailed short story (at least 3000 words) about a \
             lighthouse keeper on a stormy night. Do not stop until the story is complete. \
             Do not use any tool, just write the story directly in your reply.",
        )
        .await
        .expect("prompt accepted");

    journey
        .client
        .wait_for_turn_to_start()
        .await
        .expect("the turn starts");
    // Empirically, Claude Code's own stdin control-frame reader is not
    // instantly live the moment the first `content_block_start` reaches us —
    // an `interrupt` fired in the same instant the turn is observed to start
    // is silently swallowed rather than queued (confirmed by hand against
    // the real CLI: a request 3s in is honored every time, one sent at t=0
    // is not). Give it a moment to actually be generating before we ask it
    // to stop — three seconds, which is the figure that was measured, not the
    // two it used to wait: at two it is occasionally swallowed and the turn runs
    // to completion, failing this for a reason that has nothing to do with us.
    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
    journey
        .client
        .call(Request::SessionInterrupt {
            session_id: session.clone(),
        })
        .await
        .expect("interrupt accepted");

    let events = journey.client.drain_turn().await.expect("the turn settles");
    assert!(
        events.canceled(),
        "a stopped turn must say it was stopped, not completed or failed: {:?}",
        events.last()
    );

    journey.finish().await;
}

/// Deny is the other half of `respond_permission`; this is the default mode's
/// path, where the daemon actually asks and we say no.
#[tokio::test]
async fn denying_a_permission_request_stops_the_tool_without_touching_disk() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .send(
            &session,
            "Create a file named denied.txt containing exactly: hello, using your Write tool.",
        )
        .await
        .expect("prompt accepted");

    let request_id = journey
        .client
        .wait_for_permission_request(&session)
        .await
        .expect("default mode asks before writing");
    journey
        .client
        .call(Request::SessionRespondPermission {
            session_id: session.clone(),
            request_id,
            outcome: PermissionOutcome::Selected {
                option_id: "deny".into(),
            },
        })
        .await
        .expect("deny is accepted");

    // Claude Code retries a denied tool a few times before giving up and
    // answering in text instead, so the turn still completes — it just must
    // never have touched the filesystem.
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert!(
        events.completed() || events.canceled(),
        "a denial should not itself fail the turn: saw {:?}",
        events.failure()
    );
    assert!(
        !journey.file_exists("denied.txt"),
        "a denied Write must never reach the filesystem"
    );

    journey.finish().await;
}

/// Points the already-installed `claude` CLI at DeepSeek the same way a user
/// would: environment variables Claude Code itself documents, set on the
/// daemon's own process so the child it spawns inherits them. The daemon never
/// reads or writes these; it just spawns a process (`docs/architecture.md` §3).
fn point_claude_code_at_deepseek(journey: &Journey) {
    std::env::set_var("ANTHROPIC_BASE_URL", DEEPSEEK_ANTHROPIC_BASE_URL);
    std::env::set_var("ANTHROPIC_AUTH_TOKEN", &journey.model.api_key);
    std::env::set_var("ANTHROPIC_API_KEY", &journey.model.api_key);
    for var in [
        "ANTHROPIC_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "CLAUDE_CODE_SUBAGENT_MODEL",
    ] {
        std::env::set_var(var, journey.model.bare_id());
    }
}
