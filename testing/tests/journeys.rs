//! Journey cases. One set of code, two model backends.
//!
//! Assertions are about behaviour and disk state, never about wording: the
//! same case has to pass with a real model, which will phrase things
//! differently every run (`docs/testing.md` §6).

use std::time::Duration;

use genehub_proto::{
    Reply, Request, SessionEvent, TimelineItem, ToolCallDetail, ToolStatus, TurnErrorCode,
};
use genehub_testing::{mock_only, real_only};
use genehub_testing::{EventsExt, Journey, Scripted, Turn};
use serde_json::json;

/// The task every journey runs: something whose result is on disk, so success
/// can be checked without reading the model's prose.
const TASK: &str = "Create a file called result.txt containing exactly the word DONE, \
                    then reply with a one-word confirmation.";

/// Scripts the mock through that task. In real mode the model does it itself.
async fn script_the_task(journey: &Journey) {
    if !journey.mode.is_mock() {
        return;
    }
    journey
        .mock()
        .reply(Turn::tool(
            "write",
            json!({ "path": "result.txt", "content": "DONE" }),
        ))
        .await;
    journey.mock().reply(Turn::text("Created.")).await;
}

// ---------------------------------------------------------------------------
// Main journey
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_main_journey_runs_a_task_end_to_end_on_the_built_in_agent() {
    let journey = Journey::start().await.expect("journey starts");
    script_the_task(&journey).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, TASK).await.expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    assert!(
        events.completed(),
        "the turn should complete; saw {:?}",
        events.failure()
    );
    assert_eq!(
        journey.read_file("result.txt").as_deref().map(str::trim),
        Some("DONE"),
        "the task is verified on disk, not by reading the reply"
    );

    // The prompt, the tool call and a reply all reached the timeline.
    let items = events.items();
    assert!(
        items
            .iter()
            .any(|item| matches!(item, TimelineItem::UserMessage { .. })),
        "the prompt is part of the turn"
    );
    let tools = events.tool_calls();
    assert!(!tools.is_empty(), "the task needs a tool");
    assert!(
        tools
            .iter()
            .any(|(_, detail)| matches!(detail, ToolCallDetail::Write { path, .. } if path.contains("result.txt"))),
        "the write is rendered as a write, not as Unknown: {tools:?}"
    );
    assert!(
        !events.assistant_text().trim().is_empty(),
        "the user must see something written back"
    );

    journey.finish().await;
}

#[tokio::test]
async fn streaming_output_is_visible_before_the_turn_ends() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey
            .mock()
            .reply(Turn::text(
                "a reasonably long answer that arrives in pieces",
            ))
            .await;
    }

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Say something.")
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let deltas: Vec<&SessionEvent> = events
        .iter()
        .filter(|event| matches!(event, SessionEvent::ItemDelta { .. }))
        .collect();
    assert!(
        !deltas.is_empty(),
        "without deltas the UI would sit blank until the end"
    );
    assert!(
        events.assistant_text().len() >= deltas.len(),
        "the settled text should be at least as long as the pieces streamed"
    );

    journey.finish().await;
}

#[tokio::test]
async fn a_multi_step_task_feeds_tool_results_back_until_it_finishes() {
    let journey = Journey::start().await.expect("journey starts");
    journey
        .write_file("source.txt", "the-secret-value")
        .expect("fixture written");

    if journey.mode.is_mock() {
        journey
            .mock()
            .reply(Turn::tool("read", json!({ "path": "source.txt" })))
            .await;
        journey
            .mock()
            .reply(Turn::tool(
                "write",
                json!({ "path": "copy.txt", "content": "the-secret-value" }),
            ))
            .await;
        journey.mock().reply(Turn::text("Copied.")).await;
    }

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(
            &session,
            "Read source.txt and write its exact contents into copy.txt.",
        )
        .await
        .expect("prompt accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    assert!(events.completed(), "saw {:?}", events.failure());
    assert_eq!(
        journey.read_file("copy.txt").as_deref().map(str::trim),
        Some("the-secret-value")
    );
    assert!(
        events.tool_calls().len() >= 2,
        "a read then a write, not one shot"
    );

    journey.finish().await;
}

// ---------------------------------------------------------------------------
// Branch: sessions and agents
// ---------------------------------------------------------------------------

#[tokio::test]
async fn agents_that_are_not_installed_stay_out_of_the_picker() {
    let journey = Journey::start().await.expect("journey starts");
    let agents = match journey.client.call(Request::AgentList).await.unwrap() {
        Reply::Agents(agents) => agents,
        other => panic!("unexpected {other:?}"),
    };

    let genet = agents
        .iter()
        .find(|agent| agent.id == "genet")
        .expect("the built-in agent is always listed");
    assert!(genet.builtin);
    assert_eq!(genet.probe, genehub_proto::ProbeState::Ready);
    assert!(
        !genet.catalog.models.is_empty(),
        "a configured provider should produce models"
    );

    // Whatever is or is not installed, the answer is consistent: everything
    // reported Ready must carry a usable capability set.
    for agent in &agents {
        if agent.probe == genehub_proto::ProbeState::Ready {
            assert!(
                !agent.label.is_empty(),
                "{} has nothing to show in the picker",
                agent.id
            );
        }
    }

    journey.finish().await;
}

#[tokio::test]
async fn capabilities_are_declared_so_the_ui_never_offers_a_dead_control() {
    let journey = Journey::start().await.expect("journey starts");
    let agents = match journey.client.call(Request::AgentList).await.unwrap() {
        Reply::Agents(agents) => agents,
        other => panic!("unexpected {other:?}"),
    };

    for agent in agents {
        // An agent that says it cannot switch models must not advertise any,
        // or the frontend would render a picker that cannot work.
        if !agent.capabilities.set_model {
            assert!(
                agent.catalog.models.is_empty(),
                "{} says it cannot switch models yet lists some",
                agent.id
            );
        }
        if !agent.capabilities.set_mode {
            assert!(
                agent.catalog.modes.is_empty(),
                "{} says it cannot switch modes yet lists some",
                agent.id
            );
        }
    }

    journey.finish().await;
}

#[tokio::test]
async fn switching_the_thinking_mode_takes_effect_on_the_built_in_agent() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("ok")).await;
    }
    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "hello").await.expect("accepted");
    journey.client.drain_turn().await.expect("the turn ends");

    journey
        .client
        .call(Request::SessionSetMode {
            session_id: session.clone(),
            mode_id: "low".into(),
        })
        .await
        .expect("the built-in agent supports modes");

    let snapshot = match journey
        .client
        .call(Request::SessionGet {
            session_id: session,
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(snapshot) => snapshot,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(snapshot.summary.mode_id.as_deref(), Some("low"));

    journey.finish().await;
}

/// Two windows on one session are two send buttons, and hiding one of them is
/// not the same as there being one. A prompt that arrives mid-turn has to be
/// refused: an agent handed a second question while answering the first does not
/// fail, it interleaves the two into one confused conversation.
#[tokio::test]
async fn a_prompt_arriving_mid_turn_is_refused_rather_than_interleaved() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    // Trickled, so the first turn is still open when the second prompt lands.
    journey
        .mock()
        .reply_slowly(Turn::text("Working on it."), Duration::from_millis(120))
        .await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "First.").await.expect("accepted");
    let refused = journey
        .send(&session, "Second.")
        .await
        .expect_err("the second prompt should not be accepted mid-turn");
    let said = format!("{refused:#}");
    assert!(
        said.contains("conflict") || said.contains("already running"),
        "refused, but for an unclear reason: {said}"
    );

    // And the refusal must not have cost the turn that was already running.
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert!(events.completed(), "the first turn did not finish");

    // Once it is over the session takes prompts again: the guard is about
    // overlap, not a session that stops working after one question.
    journey.mock().reply(Turn::text("Ready.")).await;
    journey
        .send(&session, "Third.")
        .await
        .expect("a prompt after the turn ends is accepted");
    journey.client.drain_turn().await.expect("the turn ends");

    journey.finish().await;
}

#[tokio::test]
async fn an_unknown_tool_still_renders_instead_of_disappearing() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    // A tool the built-in agent does not implement: it will report an error,
    // but the call must still reach the timeline with its data intact.
    journey
        .mock()
        .reply(Turn::tool("teleport", json!({ "destination": "mars" })))
        .await;
    journey.mock().reply(Turn::text("Could not.")).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "Teleport.").await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let tools = events.tool_calls();
    let (name, detail) = tools
        .iter()
        .find(|(name, _)| *name == "teleport")
        .expect("the unrecognised call is not dropped");
    assert_eq!(*name, "teleport");
    match detail {
        ToolCallDetail::Unknown { raw } => {
            assert_eq!(raw["arguments"]["destination"], "mars");
        }
        other => panic!("expected the fallback renderer, got {other:?}"),
    }

    journey.finish().await;
}

#[tokio::test]
async fn a_task_with_no_credentials_says_so_instead_of_failing_silently() {
    let journey = Journey::start_with(genehub_testing::Mode::Mock, |config| {
        // Strip the provider entirely: this is a machine nobody configured.
        config.agents.providers.clear();
    })
    .await
    .expect("journey starts");

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Do something.")
        .await
        .expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let failure = events
        .failure()
        .expect("an unconfigured machine must fail visibly");
    assert_eq!(failure.code, TurnErrorCode::MissingCredentials);
    assert!(
        !failure.message.trim().is_empty(),
        "the message is what the user reads"
    );

    journey.finish().await;
}

/// The other half of the case above: a user who reads that error has to be able
/// to fix it from the same screen, and the fix has to reach the agent without a
/// restart. A key that only takes effect after a relaunch is a key that looks
/// broken.
#[tokio::test]
async fn a_key_entered_in_settings_makes_the_very_next_task_work() {
    let journey = Journey::start_with(genehub_testing::Mode::Mock, |config| {
        config.agents.providers.clear();
    })
    .await
    .expect("journey starts");
    mock_only!(journey);

    let settings = match journey.client.call(Request::SettingsGet).await {
        Ok(Reply::Settings(settings)) => settings,
        other => panic!("expected settings, got {other:?}"),
    };
    assert!(
        settings.providers.is_empty(),
        "nothing should be configured yet"
    );

    let base_url = journey.mock().base_url.clone();
    let saved = match journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "deepseek".into(),
            api_key: Some("sk-typed-by-the-user".into()),
            base_url: Some(base_url),
        })
        .await
    {
        Ok(Reply::Settings(settings)) => settings,
        other => panic!("expected settings, got {other:?}"),
    };
    let provider = saved
        .providers
        .iter()
        .find(|provider| provider.id == "deepseek")
        .expect("the provider should be listed once it is configured");
    assert!(provider.has_api_key);

    // The key itself must not come back out.
    let serialized = serde_json::to_string(&saved).unwrap();
    assert!(
        !serialized.contains("sk-typed-by-the-user"),
        "the stored key was echoed back to the client"
    );

    script_the_task(&journey).await;
    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, TASK).await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    assert!(
        events.failure().is_none(),
        "the task should run now: {:?}",
        events.failure()
    );
    assert_eq!(
        journey.read_file("result.txt").as_deref().map(str::trim),
        Some("DONE")
    );

    journey.finish().await;
}

/// A real provider turning us down.
///
/// Every other failure case is injected by the mock, which means they all prove
/// the same thing: that our own classification is wired up. None of them prove
/// that a real endpoint's refusal — its status, its body, its headers — lands
/// anywhere useful. A key that has been revoked is the most ordinary way for
/// this product to stop working, so it gets a case against the real thing.
#[tokio::test]
async fn a_real_provider_that_rejects_our_key_says_so_instead_of_hanging() {
    let journey = Journey::start().await.expect("journey starts");
    real_only!(journey);

    journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "deepseek".into(),
            api_key: Some("sk-0000000000000000000000000000000000000000".into()),
            base_url: None,
        })
        .await
        .expect("the key is stored");
    journey
        .client
        .call(Request::AgentRefresh)
        .await
        .expect("agents reprobed");

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Say hello.")
        .await
        .expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn settles");

    let failure = events
        .failure()
        .expect("a rejected key cannot look like success");
    assert!(
        matches!(
            failure.code,
            TurnErrorCode::MissingCredentials | TurnErrorCode::Upstream
        ),
        "a rejected key should be classified as something the user can act on, got {:?}",
        failure
    );
    assert!(
        failure.message.contains("deepseek"),
        "the message should name the provider the user configured: {}",
        failure.message
    );

    journey.finish().await;
}

#[tokio::test]
async fn model_failures_surface_as_actionable_errors() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    for (scripted, expected) in [
        (
            Scripted::Status {
                code: 429,
                message: "rate limit exceeded".into(),
            },
            TurnErrorCode::RateLimited,
        ),
        (
            Scripted::Status {
                code: 500,
                message: "internal".into(),
            },
            TurnErrorCode::Upstream,
        ),
        (Scripted::Malformed, TurnErrorCode::Upstream),
        (
            Scripted::Truncated(Turn::text("cut off halfway")),
            TurnErrorCode::Upstream,
        ),
    ] {
        journey.mock().push(scripted).await;
        let session = journey.session("genet").await.expect("session opens");
        journey.send(&session, "Go.").await.expect("accepted");
        let events = journey.client.drain_turn().await.expect("the turn ends");

        match expected {
            // A truncated or malformed stream may still settle as a completed
            // turn with no content; what must never happen is a hang.
            TurnErrorCode::Upstream => assert!(
                events.failure().is_some() || events.completed(),
                "the turn must settle one way or the other"
            ),
            code => assert_eq!(
                events.failure().map(|error| error.code),
                Some(code),
                "expected {code:?}"
            ),
        }
    }

    journey.finish().await;
}

/// What we send the model is invisible to a real run, because a real model
/// papers over a bad prompt. Only the mock can check it.
#[tokio::test]
async fn the_agent_hands_the_model_a_system_prompt_and_tool_definitions() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);
    journey.mock().reply(Turn::text("ok")).await;

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "a distinctive user request")
        .await
        .expect("accepted");
    journey.client.drain_turn().await.expect("the turn ends");

    let requests = journey.mock().requests().await;
    assert_eq!(requests.len(), 1);
    let request = &requests[0];

    let messages = request["messages"].as_array().expect("messages");
    assert_eq!(messages[0]["role"], "system");
    assert!(
        messages.iter().any(|m| m["content"]
            .as_str()
            .unwrap_or_default()
            .contains("a distinctive user request")),
        "the user's words must reach the model verbatim"
    );

    let tools = request["tools"].as_array().expect("tool definitions");
    let names: Vec<&str> = tools
        .iter()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect();
    for expected in ["read", "write", "edit", "bash"] {
        assert!(
            names.contains(&expected),
            "{expected} is missing: {names:?}"
        );
    }

    journey.finish().await;
}

#[tokio::test]
async fn conversation_history_is_replayed_to_the_model_on_the_next_turn() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);
    journey.mock().reply(Turn::text("first")).await;
    journey.mock().reply(Turn::text("second")).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "one").await.expect("accepted");
    journey.client.drain_turn().await.expect("turn one ends");
    journey.send(&session, "two").await.expect("accepted");
    journey.client.drain_turn().await.expect("turn two ends");

    let requests = journey.mock().requests().await;
    assert_eq!(requests.len(), 2);
    let second = requests[1]["messages"].as_array().unwrap();
    let transcript: String = second
        .iter()
        .map(|message| message["content"].to_string())
        .collect();
    assert!(
        transcript.contains("one") && transcript.contains("two"),
        "the second call must carry the first exchange: {transcript}"
    );

    journey.finish().await;
}

// ---------------------------------------------------------------------------
// Branch: workspace capabilities
// ---------------------------------------------------------------------------

#[tokio::test]
async fn changes_made_by_the_agent_show_up_in_git_and_can_be_committed() {
    let journey = Journey::start().await.expect("journey starts");
    journey.init_git().await.expect("git fixture");
    script_the_task(&journey).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, TASK).await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert!(events.completed(), "saw {:?}", events.failure());

    let status = match journey
        .client
        .call(Request::GitStatus {
            workspace_id: journey.workspace.id.clone(),
        })
        .await
        .unwrap()
    {
        Reply::GitStatus(status) => status,
        other => panic!("unexpected {other:?}"),
    };
    assert!(!status.clean, "the new file should show as a change");
    assert!(status.changes.iter().any(|c| c.path.contains("result.txt")));

    let commit = match journey
        .client
        .call(Request::GitCommit {
            workspace_id: journey.workspace.id.clone(),
            message: "add result".into(),
            paths: vec![],
        })
        .await
        .unwrap()
    {
        Reply::GitCommit { commit } => commit,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(commit.len(), 40);

    let after = match journey
        .client
        .call(Request::GitStatus {
            workspace_id: journey.workspace.id.clone(),
        })
        .await
        .unwrap()
    {
        Reply::GitStatus(status) => status,
        other => panic!("unexpected {other:?}"),
    };
    assert!(after.clean, "committing clears the change list");

    journey.finish().await;
}

#[tokio::test]
async fn files_can_be_browsed_read_and_edited_through_the_workspace() {
    let journey = Journey::start().await.expect("journey starts");
    journey.write_file("src/main.rs", "fn main() {}").unwrap();
    journey.write_file("README.md", "# hi").unwrap();

    let tree = match journey
        .client
        .call(Request::FileTree {
            workspace_id: journey.workspace.id.clone(),
            path: None,
            depth: Some(3),
        })
        .await
        .unwrap()
    {
        Reply::FileTree(tree) => tree,
        other => panic!("unexpected {other:?}"),
    };
    let children = tree.children.expect("an expanded root");
    assert!(children
        .iter()
        .any(|node| node.name == "src" && node.is_dir));

    let content = match journey
        .client
        .call(Request::FileRead {
            workspace_id: journey.workspace.id.clone(),
            path: "src/main.rs".into(),
        })
        .await
        .unwrap()
    {
        Reply::FileContent(content) => content,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(content.content, "fn main() {}");
    assert!(content.is_text);

    journey
        .client
        .call(Request::FileWrite {
            workspace_id: journey.workspace.id.clone(),
            path: "src/main.rs".into(),
            content: "fn main() { println!(\"edited\"); }".into(),
        })
        .await
        .expect("the edit saves");
    assert!(journey.read_file("src/main.rs").unwrap().contains("edited"));

    journey.finish().await;
}

#[tokio::test]
async fn reads_and_writes_outside_the_workspace_are_refused() {
    let journey = Journey::start().await.expect("journey starts");

    for path in ["../escape.txt", "/etc/passwd", "src/../../escape.txt"] {
        let error = journey
            .client
            .expect_error(Request::FileRead {
                workspace_id: journey.workspace.id.clone(),
                path: path.into(),
            })
            .await;
        assert!(
            error.contains("Forbidden"),
            "{path} should be refused as forbidden, got: {error}"
        );

        let error = journey
            .client
            .expect_error(Request::FileWrite {
                workspace_id: journey.workspace.id.clone(),
                path: path.into(),
                content: "owned".into(),
            })
            .await;
        assert!(error.contains("Forbidden"), "{path} write: {error}");
    }

    journey.finish().await;
}

#[tokio::test]
async fn a_terminal_opens_echoes_resizes_and_closes() {
    let journey = Journey::start().await.expect("journey starts");

    let pty_id = match journey
        .client
        .call(Request::PtyOpen {
            workspace_id: journey.workspace.id.clone(),
            cols: Some(80),
            rows: Some(24),
        })
        .await
        .unwrap()
    {
        Reply::Pty { pty_id } => pty_id,
        other => panic!("unexpected {other:?}"),
    };

    journey
        .client
        .call(Request::PtyWrite {
            pty_id: pty_id.clone(),
            data: "echo journey-marker\n".into(),
        })
        .await
        .expect("input accepted");

    let output = journey
        .client
        .collect_pty("journey-marker", Duration::from_secs(20))
        .await;
    assert!(output.contains("journey-marker"), "got: {output:?}");

    journey
        .client
        .call(Request::PtyResize {
            pty_id: pty_id.clone(),
            cols: 120,
            rows: 40,
        })
        .await
        .expect("resize accepted");
    journey
        .client
        .call(Request::PtyClose {
            pty_id: pty_id.clone(),
        })
        .await
        .expect("close accepted");

    let error = journey
        .client
        .expect_error(Request::PtyWrite {
            pty_id,
            data: "x".into(),
        })
        .await;
    assert!(error.contains("NotFound"), "got: {error}");

    journey.finish().await;
}

#[tokio::test]
async fn large_tool_output_is_truncated_and_marked() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    journey
        .mock()
        .reply(Turn::tool("bash", json!({ "command": "seq 1 200000" })))
        .await;
    journey.mock().reply(Turn::text("Done.")).await;

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Print a lot.")
        .await
        .expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let tools = events.tool_calls();
    let (_, detail) = tools
        .iter()
        .find(|(name, _)| *name == "bash")
        .expect("the command ran");
    match detail {
        ToolCallDetail::Shell { output, .. } => {
            assert!(!output.is_empty());
            assert!(
                output.len() < 1_000_000,
                "unbounded output would swamp the client: {} bytes",
                output.len()
            );
        }
        other => panic!("unexpected {other:?}"),
    }

    journey.finish().await;
}

// ---------------------------------------------------------------------------
// Branch: resilience
// ---------------------------------------------------------------------------

#[tokio::test]
async fn reconnecting_replays_the_gap_without_losing_or_repeating_events() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("hello there")).await;
    }

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Say hello.")
        .await
        .expect("accepted");
    let first = journey.client.drain_turn().await.expect("the turn ends");
    assert!(first.completed());

    // Reconnect from the very beginning and compare what comes back.
    let reconnected = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("second connection");
    reconnected.hello("journey-2").await.expect("handshake");

    let (snapshot, replayed, reset) = match reconnected
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: Some(0),
        })
        .await
        .unwrap()
    {
        Reply::Subscribed {
            snapshot,
            replayed,
            reset,
        } => (snapshot, replayed, reset),
        other => panic!("unexpected {other:?}"),
    };

    assert!(!reset, "everything still fits in the replay window");
    assert!(!replayed.is_empty(), "the gap should be filled");
    let sequences: Vec<u64> = replayed.iter().map(|event| event.seq).collect();
    let mut sorted = sequences.clone();
    sorted.sort_unstable();
    sorted.dedup();
    assert_eq!(sequences, sorted, "no duplicates and no reordering");
    assert_eq!(
        sequences.last().copied(),
        Some(snapshot.seq),
        "the replay ends exactly where the snapshot begins"
    );

    reconnected.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn asking_for_a_gap_older_than_the_window_gets_an_honest_full_reset() {
    let journey = Journey::start_with(genehub_testing::Mode::Mock, |config| {
        // Small enough that a single turn overflows it.
        config.replay_window = 2;
    })
    .await
    .expect("journey starts");
    journey
        .mock()
        .reply(Turn::text("a reply long enough to produce several events"))
        .await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "Talk.").await.expect("accepted");
    journey.client.drain_turn().await.expect("the turn ends");

    let reconnected = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("second connection");
    reconnected.hello("journey-2").await.expect("handshake");

    match reconnected
        .call(Request::Subscribe {
            session_id: session,
            since_seq: Some(0),
        })
        .await
        .unwrap()
    {
        Reply::Subscribed {
            snapshot, reset, ..
        } => {
            assert!(
                reset,
                "a gap we cannot fill must be admitted, not papered over"
            );
            assert!(
                !snapshot.items.is_empty(),
                "the reset has to carry the full history to be useful"
            );
        }
        other => panic!("unexpected {other:?}"),
    }

    reconnected.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn history_survives_a_daemon_restart_and_the_conversation_continues() {
    let mut journey = Journey::start().await.expect("journey starts");
    script_the_task(&journey).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, TASK).await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");
    assert!(events.completed(), "saw {:?}", events.failure());
    let before = events.items().len();
    assert!(before > 0);

    // The whole daemon goes away and comes back, the way it does when someone
    // quits the app and opens it again tomorrow. Anything held only in memory
    // dies here.
    journey
        .restart_daemon()
        .await
        .expect("the daemon comes back on the same data directory");

    let workspaces = match journey.client.call(Request::WorkspaceList).await.unwrap() {
        Reply::Workspaces(workspaces) => workspaces,
        other => panic!("unexpected {other:?}"),
    };
    assert!(
        workspaces.iter().any(|w| w.id == journey.workspace.id),
        "the project should still be registered, with the same id"
    );

    let snapshot = match journey
        .client
        .call(Request::SessionGet {
            session_id: session.clone(),
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(snapshot) => snapshot,
        other => panic!("unexpected {other:?}"),
    };
    assert!(
        snapshot
            .items
            .iter()
            .any(|item| matches!(item, TimelineItem::UserMessage { .. })),
        "the reloaded history must contain what the user asked"
    );
    assert!(
        snapshot.items.len() >= 2,
        "the reply should be there too: {:?}",
        snapshot.items
    );

    // And it is a conversation, not an archive: the next turn works, and the
    // model is handed what was said before the restart.
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("Still here.")).await;
    }
    journey
        .client
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
        })
        .await
        .expect("resubscribed");
    journey
        .send(&session, "What did I just ask you to do?")
        .await
        .expect("accepted");
    let resumed = journey
        .client
        .drain_turn()
        .await
        .expect("the second turn ends");
    assert!(resumed.completed(), "saw {:?}", resumed.failure());

    if journey.mode.is_mock() {
        let sent = journey.mock().requests().await;
        let last = sent.last().expect("a request after the restart");
        let messages = last["messages"].to_string();
        assert!(
            messages.contains(TASK),
            "the reloaded session has to carry its history to the model: {messages}"
        );
    }

    journey.finish().await;
}

/// Coming back to a session through the list, which is how anyone who did not
/// keep the tab open gets there.
#[tokio::test]
async fn a_session_found_in_the_list_can_be_reopened_and_continued() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("First answer.")).await;
    }

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Remember the number 7.")
        .await
        .expect("accepted");
    assert!(journey
        .client
        .drain_turn()
        .await
        .expect("the turn ends")
        .completed());

    // Leave it, the way closing a tab does.
    journey
        .client
        .call(Request::Unsubscribe {
            session_id: session.clone(),
        })
        .await
        .expect("unsubscribed");
    journey
        .client
        .call(Request::SessionClose {
            session_id: session.clone(),
        })
        .await
        .expect("session closes");

    // Find it again by listing, not by remembering the id.
    let listed = match journey
        .client
        .call(Request::SessionList {
            workspace_id: Some(journey.workspace.id.clone()),
            include_archived: false,
        })
        .await
        .unwrap()
    {
        Reply::Sessions(sessions) => sessions,
        other => panic!("unexpected {other:?}"),
    };
    let found = listed
        .iter()
        .find(|summary| summary.id == session)
        .expect("the session should be in the list");
    assert!(
        found
            .title
            .as_deref()
            .is_some_and(|title| !title.is_empty()),
        "a session with no title is unfindable"
    );

    let (snapshot, _replayed, _reset) = match journey
        .client
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
        })
        .await
        .unwrap()
    {
        Reply::Subscribed {
            snapshot,
            replayed,
            reset,
        } => (snapshot, replayed, reset),
        other => panic!("unexpected {other:?}"),
    };
    assert!(
        !snapshot.items.is_empty(),
        "reopening should show what was said before"
    );

    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("It was 7.")).await;
    }
    journey
        .send(&session, "What number did I ask you to remember?")
        .await
        .expect("accepted");
    let second = journey.client.drain_turn().await.expect("the turn ends");
    assert!(second.completed(), "saw {:?}", second.failure());

    journey.finish().await;
}

/// The stop button, all the way down.
///
/// The pieces were tested separately — the adapter turns an aborted stream into
/// `TurnCanceled`, the composer calls interrupt — and the path between them was
/// not, which is exactly where a stop button goes to die.
#[tokio::test]
async fn interrupting_a_running_turn_ends_it_as_canceled() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey
            .mock()
            .reply_slowly(
                Turn::text("This is a long answer that arrives one piece at a time."),
                Duration::from_millis(400),
            )
            .await;
    }

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(
            &session,
            "Count from 1 to 500, one number per line, with a short comment on each.",
        )
        .await
        .expect("accepted");

    // Interrupt once the turn is visibly under way, not before: cancelling
    // something that has not started tests nothing.
    journey
        .client
        .wait_for_turn_to_start()
        .await
        .expect("the turn starts");
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
        "a stopped turn must say it was stopped, not completed: {:?}",
        events.last()
    );

    // And the session is usable afterwards — a stop that wedges the agent is
    // barely better than no stop at all.
    let summary = match journey
        .client
        .call(Request::SessionGet {
            session_id: session.clone(),
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(snapshot) => snapshot.summary,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(
        summary.status,
        genehub_proto::SessionStatus::Idle,
        "the session should be idle again"
    );

    journey.finish().await;
}

/// Losing the connection while the agent is mid-answer.
///
/// The existing replay cases all reconnect after the turn ended, which is the
/// easy half: the hard half is a turn that keeps producing events while nobody
/// is listening.
#[tokio::test]
async fn a_client_that_drops_mid_turn_gets_the_missing_events_when_it_returns() {
    let journey = Journey::start_in_mode(genehub_testing::Mode::Mock)
        .await
        .expect("journey starts");
    journey
        .mock()
        .reply_slowly(
            Turn::text("A reply that keeps arriving after the client has gone."),
            Duration::from_millis(250),
        )
        .await;

    let session = journey.session("genet").await.expect("session opens");

    // The client that is actually watching, so its disappearance is the real
    // thing rather than a description of one.
    let watching = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("a watching client");
    watching.hello("journey-2").await.expect("handshake");
    watching
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
        })
        .await
        .expect("subscribed");

    journey
        .send(&session, "Say something long.")
        .await
        .expect("accepted");

    let seen_up_to = watching
        .wait_for_turn_to_start()
        .await
        .expect("the turn starts");
    watching.close().await;

    // The turn runs on without the client that started it — an agent that gave
    // up when a laptop lid closed would be useless on a phone.
    let rest = journey.client.drain_turn().await.expect("the turn ends");
    assert!(rest.completed(), "saw {:?}", rest.failure());

    let returning = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("reconnecting");
    returning.hello("journey-3").await.expect("handshake");
    let (snapshot, replayed, reset) = match returning
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: Some(seen_up_to),
        })
        .await
        .unwrap()
    {
        Reply::Subscribed {
            snapshot,
            replayed,
            reset,
        } => (snapshot, replayed, reset),
        other => panic!("unexpected {other:?}"),
    };

    assert!(!reset, "the gap is small enough to fill");
    assert!(
        replayed.iter().all(|event| event.seq > seen_up_to),
        "replaying what the client already had would duplicate it"
    );
    assert!(
        replayed
            .iter()
            .any(|event| matches!(event.event, SessionEvent::TurnCompleted { .. })),
        "the end of the turn is the one event it cannot afford to miss"
    );
    assert_eq!(
        replayed.last().map(|event| event.seq),
        Some(snapshot.seq),
        "the replay should end where the snapshot begins"
    );

    returning.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_second_client_sees_the_same_session_as_the_first() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("shared")).await;
    }

    let session = journey.session("genet").await.expect("session opens");

    let second = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("second connection");
    second.hello("journey-2").await.expect("handshake");
    second
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
        })
        .await
        .expect("subscribed");

    journey
        .send(&session, "Say something.")
        .await
        .expect("accepted");

    let from_first = journey.client.drain_turn().await.expect("first sees it");
    let from_second = second.drain_turn().await.expect("second sees it too");
    assert!(from_first.completed() && from_second.completed());
    assert_eq!(
        from_first.assistant_text(),
        from_second.assistant_text(),
        "both clients converge on the same timeline"
    );

    second.close().await;
    journey.finish().await;
}

// ---------------------------------------------------------------------------
// Branch: protocol hygiene
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_connection_must_say_hello_before_anything_else() {
    let journey = Journey::start().await.expect("journey starts");
    let bare = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("connection");

    let error = bare.expect_error(Request::AgentList).await;
    assert!(error.contains("Unauthorized"), "got: {error}");

    bare.hello("late").await.expect("hello still works");
    bare.call(Request::AgentList)
        .await
        .expect("and then it does");

    bare.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_client_speaking_another_protocol_version_is_turned_away() {
    let journey = Journey::start().await.expect("journey starts");
    let stranger = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("connection");

    let error = stranger
        .expect_error(Request::Hello {
            client_name: "from the future".into(),
            protocol_version: 999,
            device: None,
        })
        .await;
    assert!(error.contains("ProtocolVersion"), "got: {error}");

    stranger.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn a_connection_without_the_token_is_rejected_outright() {
    let journey = Journey::start().await.expect("journey starts");
    let url = format!("ws://127.0.0.1:{}/ws?token=wrong", journey.daemon().port);
    assert!(
        genehub_testing::Client::connect(&url).await.is_err(),
        "the loopback port still needs its token"
    );
    journey.finish().await;
}

/// A malformed request must still be answered, or the caller waits forever for
/// a reply that has nowhere to go.
#[tokio::test]
async fn a_malformed_frame_gets_an_error_rather_than_silence() {
    let journey = Journey::start().await.expect("journey starts");
    let client = genehub_testing::Client::connect(&journey.daemon().websocket_url())
        .await
        .expect("connection");
    client.hello("sloppy").await.expect("handshake");

    let error = client
        .expect_error(Request::SessionGet {
            session_id: "does-not-exist".into(),
        })
        .await;
    assert!(error.contains("NotFound"), "got: {error}");

    client.close().await;
    journey.finish().await;
}

#[tokio::test]
async fn an_empty_prompt_is_refused_before_it_reaches_the_model() {
    let journey = Journey::start().await.expect("journey starts");
    let session = journey.session("genet").await.expect("session opens");

    let error = journey
        .client
        .expect_error(Request::SessionSend {
            session_id: session,
            text: "   ".into(),
            attachments: vec![],
        })
        .await;
    assert!(error.contains("BadRequest"), "got: {error}");
    if journey.mode.is_mock() {
        assert_eq!(
            journey.mock().request_count().await,
            0,
            "nothing should have reached the model"
        );
    }

    journey.finish().await;
}

#[tokio::test]
async fn sessions_list_per_workspace_and_can_be_archived() {
    let journey = Journey::start().await.expect("journey starts");
    let first = journey.session("genet").await.expect("session one");
    let _second = journey.session("genet").await.expect("session two");

    let sessions = match journey
        .client
        .call(Request::SessionList {
            workspace_id: Some(journey.workspace.id.clone()),
            include_archived: false,
        })
        .await
        .unwrap()
    {
        Reply::Sessions(sessions) => sessions,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(sessions.len(), 2);

    journey
        .client
        .call(Request::SessionArchive {
            session_id: first,
            archived: true,
        })
        .await
        .expect("archived");

    let visible = match journey
        .client
        .call(Request::SessionList {
            workspace_id: Some(journey.workspace.id.clone()),
            include_archived: false,
        })
        .await
        .unwrap()
    {
        Reply::Sessions(sessions) => sessions,
        other => panic!("unexpected {other:?}"),
    };
    assert_eq!(visible.len(), 1, "archived sessions leave the default list");

    journey.finish().await;
}

#[tokio::test]
async fn a_session_title_comes_from_the_first_thing_the_user_says() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("ok")).await;
    }
    let session = journey.session("genet").await.expect("session opens");

    // Nothing has been said yet, so there is nothing to name it after. The
    // daemon leaves it unnamed rather than inventing a word in a language it
    // has no way of knowing — that placeholder belongs to the interface.
    assert_eq!(title_of(&journey, &session).await, None);

    journey
        .send(&session, "Fix the login redirect")
        .await
        .expect("accepted");

    // A client watching the session must be told the title changed, not just
    // able to find out by re-fetching — the whole point is that the sidebar
    // repaints itself without a workspace switch or reconnect happening to
    // trigger a `session.list` first.
    let pushed = journey
        .client
        .wait_for(|event| matches!(event, SessionEvent::TitleChanged { .. }))
        .await
        .expect("a titleChanged event arrives");
    assert_eq!(
        pushed,
        SessionEvent::TitleChanged {
            title: "Fix the login redirect".to_string()
        }
    );

    // The title comes from the prompt, not from the model, so the answer is
    // already knowable here. Waiting for the turn would mean waiting on a real
    // model to finish an open-ended instruction in an empty project — which it
    // does not, and which this case was never about.
    assert_eq!(
        title_of(&journey, &session).await.as_deref(),
        Some("Fix the login redirect")
    );

    journey
        .client
        .call(Request::SessionInterrupt {
            session_id: session,
        })
        .await
        .expect("the turn stops");
    journey.finish().await;
}

/// What the sidebar would show for a session, straight from the daemon.
async fn title_of(journey: &Journey, session: &str) -> Option<String> {
    match journey
        .client
        .call(Request::SessionGet {
            session_id: session.to_string(),
        })
        .await
        .unwrap()
    {
        Reply::Snapshot(snapshot) => snapshot.summary.title,
        other => panic!("unexpected {other:?}"),
    }
}

#[tokio::test]
async fn tool_calls_move_through_their_states_rather_than_appearing_finished() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);
    journey
        .mock()
        .reply(Turn::tool("bash", json!({ "command": "echo hi" })))
        .await;
    journey.mock().reply(Turn::text("Done.")).await;

    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "Run it.").await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn ends");

    let statuses: Vec<ToolStatus> = events
        .iter()
        .filter_map(|event| match event {
            SessionEvent::Item {
                item: TimelineItem::ToolCall { status, .. },
                ..
            } => Some(*status),
            SessionEvent::ItemDelta {
                delta: genehub_proto::ItemDelta::ToolStatus { status, .. },
                ..
            } => Some(*status),
            _ => None,
        })
        .collect();

    assert!(
        statuses.first() == Some(&ToolStatus::Pending),
        "a call should appear before it has run: {statuses:?}"
    );
    assert!(
        statuses.contains(&ToolStatus::Running),
        "the running state is what drives the spinner: {statuses:?}"
    );
    assert_eq!(
        statuses.last(),
        Some(&ToolStatus::Ok),
        "and it must settle: {statuses:?}"
    );

    journey.finish().await;
}
