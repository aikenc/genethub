//! The same journey, driven through Claude Code.
//!
//! Unlike OpenCode, Claude Code does not speak an OpenAI-compatible wire
//! format, so it cannot be pointed at the mock: DeepSeek's Anthropic-compatible
//! endpoint (`https://api.deepseek.com/anthropic`) is a real HTTP surface the
//! mock does not implement. This journey therefore only runs in real mode
//! (`docs/testing.md` §2.2).
//!
//! We do not manage how Claude Code reaches its model. The daemon only spawns
//! `claude-agent-acp` (Anthropic's own ACP wrapper around the Claude Agent
//! SDK) and speaks ACP to it, exactly like any other adapter; the environment
//! variables below are Claude Code's own documented way of choosing a
//! backend, not a protocol this project owns (`docs/architecture.md` §3,
//! boundary B1).

use std::path::Path;

use genehub_proto::TimelineItem;
use genehub_testing::{real_only, EventsExt, Journey};

/// Claude Code's own Anthropic-compatible base URL for DeepSeek, per
/// DeepSeek's Agent Integrations guide. Not ours to define or version.
const DEEPSEEK_ANTHROPIC_BASE_URL: &str = "https://api.deepseek.com/anthropic";

macro_rules! needs_claude_agent_acp {
    ($journey:expr) => {
        if !claude_agent_acp_installed() {
            eprintln!(
                "skipping {}: claude-agent-acp is not on PATH; \
                 `npm install -g @agentclientprotocol/claude-agent-acp` to cover this adapter",
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
    needs_claude_agent_acp!(journey);
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

    assert!(
        events.completed(),
        "the turn should complete; saw {:?}",
        events.failure()
    );
    let reply = events.assistant_text();
    assert!(
        !reply.trim().is_empty(),
        "Claude Code's reply must arrive as normalized timeline text"
    );
    assert!(
        !reply.contains(PROMPT),
        "the prompt was replayed as the answer: {reply:?}"
    );
    assert!(
        events
            .items()
            .iter()
            .any(|item| matches!(item, TimelineItem::UserMessage { .. })),
        "the prompt belongs to the turn whichever agent served it"
    );

    journey.finish().await;
}

/// Points the already-installed `claude-agent-acp` at DeepSeek the same way a
/// user would: environment variables Claude Code itself documents, set on the
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

fn claude_agent_acp_installed() -> bool {
    let Ok(path) = std::env::var("PATH") else {
        return false;
    };
    std::env::split_paths(&path).any(|dir| is_file(&dir.join("claude-agent-acp")))
}

fn is_file(candidate: &Path) -> bool {
    candidate.is_file()
}
