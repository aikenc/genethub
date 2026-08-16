//! The same journey, driven through Claude Code — natively, not through the
//! `claude-agent-acp` wrapper (`packages/daemon-core/src/session/claude.rs`).
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

use genehub_proto::{PermissionOutcome, Reply, Request, TimelineItem, ToolCallDetail, ToolStatus};
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
/// permission control back (see the portable Claude driver's doc comment). This is the
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

/// The composer's pickers are drawn from the catalog, so the catalog has to be
/// this CLI's own answer rather than a list we made up: every model id here came
/// out of an `initialize` handshake and goes back to the same CLI in a
/// `set_model`, and every mode id is a name its `--help` listed.
///
/// This is the whole reason to ask instead of hardcoding — a hardcoded
/// `--permission-mode manual` already cost one user a working Claude Code.
#[tokio::test]
async fn the_model_and_mode_pickers_offer_what_this_cli_actually_accepts() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    let Reply::Agents(agents) = journey
        .client
        .call(Request::AgentList)
        .await
        .expect("the agent list is served")
    else {
        panic!("expected the agent list");
    };
    let claude = agents
        .iter()
        .find(|agent| agent.id == "claude")
        .expect("claude is registered");

    assert!(
        claude.capabilities.set_model,
        "switching model is a control request this CLI answers"
    );
    assert!(
        !claude.catalog.models.is_empty(),
        "the handshake should have brought back this install's model list"
    );
    assert!(
        claude
            .catalog
            .modes
            .iter()
            .any(|mode| mode.id == "acceptEdits"),
        "every build lists acceptEdits; saw {:?}",
        claude.catalog.modes
    );
    // Slash commands: the list is the only part of them we need from the CLI,
    // since running one is ordinary prompt text. Outside its own terminal there
    // was no way to learn that any of these existed.
    assert!(
        claude.catalog.commands.len() > 5,
        "an install with skills lists plenty; saw {:?}",
        claude.catalog.commands
    );
    assert!(
        claude
            .catalog
            .commands
            .iter()
            .all(|command| !command.name.starts_with('/')),
        "the slash is the composer's to draw, not part of the name"
    );

    // Thinking levels, the second axis: per model, because that is how the CLI
    // reports them.
    let levels = claude
        .catalog
        .models
        .iter()
        .find(|model| !model.efforts.is_empty())
        .map(|model| model.efforts.clone())
        .expect("a model that takes effort levels names them");
    assert!(
        claude.capabilities.set_effort,
        "a build that names levels can be switched between them"
    );

    let asking = claude
        .catalog
        .default_mode
        .as_deref()
        .expect("a build we can talk to names its asking mode");
    assert!(
        asking == "default" || asking == "manual",
        "a session must start in the mode that asks, not one that acts: {asking}"
    );

    // And the switches are real: the CLI is asked, and it either agrees or the
    // control fails — a picker that moved while nothing changed would be a lie.
    //
    // After a first turn, because that is when the process exists at all: until
    // something is sent, a choice is only recorded (`ensure_started`).
    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .send(&session, "Reply with exactly one word: pong")
        .await
        .expect("prompt accepted");
    journey
        .client
        .drain_turn()
        .await
        .expect("the first turn ends");

    let model = claude.catalog.models[0].id.clone();
    journey
        .client
        .call(Request::SessionSetModel {
            session_id: session.clone(),
            model_id: model.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("the CLI's own model '{model}' is accepted: {error}"));
    journey
        .client
        .call(Request::SessionSetMode {
            session_id: session.clone(),
            mode_id: "plan".into(),
        })
        .await
        .expect("plan is a mode this build lists");
    // The CLI itself will not catch this: asked for a model it has never heard
    // of, it answers `success`, says "Set model to <whatever you typed>" and goes
    // on using the one it already had. Passing that through as success is how a
    // picker ends up showing a model nobody is talking to.
    journey
        .client
        .call(Request::SessionSetModel {
            session_id: session.clone(),
            model_id: "not-a-model-this-cli-has".into(),
        })
        .await
        .expect_err("a model this install never offered must be refused, not pretended");

    // The same on the effort axis, and the same reason: `effort: "nonsense"` also
    // comes back `success` from the CLI while it keeps thinking exactly as before.
    let level = levels.last().expect("at least one level").clone();
    journey
        .client
        .call(Request::SessionSetEffort {
            session_id: session.clone(),
            effort_id: level.clone(),
        })
        .await
        .unwrap_or_else(|error| panic!("the CLI's own level '{level}' is accepted: {error}"));
    journey
        .client
        .call(Request::SessionSetEffort {
            session_id: session.clone(),
            effort_id: "as-hard-as-you-can".into(),
        })
        .await
        .expect_err("a level this install never offered must be refused, not pretended");

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

/// A dispatched sub-agent's work belongs to it, and the CLI says whose work it is
/// with nothing but a `parent_tool_use_id` on frames that otherwise look exactly
/// like the main agent's. Miss it and the sub-agent's `Bash` appears in the
/// conversation as if the main agent had run it.
///
/// Whether a sub-agent gets dispatched is the model's call, not ours, so a run
/// where it just did the work itself is a run this cannot cover — and says so,
/// rather than passing quietly on nothing.
#[tokio::test]
async fn a_sub_agents_work_stays_inside_the_call_that_dispatched_it() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);
    needs_claude!(journey);
    point_claude_code_at_deepseek(&journey);

    let session = journey
        .session("claude")
        .await
        .expect("a session opens on Claude Code");
    journey
        .write_file("hello.txt", "the answer is 42\n")
        .expect("the workspace is writable");
    journey
        .client
        .call(Request::SessionSetMode {
            session_id: session.clone(),
            mode_id: "bypassPermissions".into(),
        })
        .await
        .expect("bypassPermissions is a mode this adapter offers");
    journey
        .send(
            &session,
            "Use your Task tool with the Explore agent to report what hello.txt \
             says. Do not read the file yourself.",
        )
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let items = events.items();
    let dispatched: Vec<_> = items
        .iter()
        .filter_map(|item| match item {
            TimelineItem::ToolCall {
                detail: ToolCallDetail::SubAgent { items, .. },
                ..
            } => Some(items),
            _ => None,
        })
        .collect();
    if dispatched.is_empty() {
        eprintln!(
            "skipping: this run answered without dispatching a sub-agent, \
             so there was nothing to nest; saw {items:?}"
        );
        journey.finish().await;
        return;
    }

    assert!(
        dispatched.iter().any(|nested| !nested.is_empty()),
        "a sub-agent that ran tools should have them on its own card; saw {dispatched:?}"
    );
    // And nowhere else. The sub-agent reads and greps; the main agent was told not
    // to, so a top-level Read here means the nesting leaked.
    let leaked: Vec<_> = items
        .iter()
        .filter(|item| {
            matches!(
                item,
                TimelineItem::ToolCall {
                    detail: ToolCallDetail::Read { .. },
                    ..
                }
            )
        })
        .collect();
    assert!(
        leaked.is_empty(),
        "a sub-agent's own steps must not appear in the conversation: {leaked:?}"
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
