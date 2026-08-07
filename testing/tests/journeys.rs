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
            .any(|(_, detail)| matches!(detail, ToolCallDetail::Overview { overview, .. } if overview.contains("result.txt"))),
        "the write keeps a useful bounded overview: {tools:?}"
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

/// What "配好 key 就能选模型" means in practice.
///
/// The list is the provider's own answer, not a table we keep: a table goes
/// stale, offers models a key has no access to, and cannot describe a provider
/// we have never heard of. What it must not do is dump everything the provider
/// sells — embeddings and speech models cannot hold a conversation, and a picker
/// where most rows are unusable is worse than a short one.
#[tokio::test]
async fn the_picker_is_filled_from_what_the_provider_says_it_has() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    let agents = match journey.client.call(Request::AgentList).await.unwrap() {
        Reply::Agents(agents) => agents,
        other => panic!("unexpected {other:?}"),
    };
    let genet = agents
        .iter()
        .find(|agent| agent.id == "genet")
        .expect("the built-in agent is always listed");

    let ids: Vec<&str> = genet
        .catalog
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(ids, vec![genehub_testing::REAL_MODEL]);
    assert!(
        !ids.iter().any(|id| id.contains("embedding")),
        "offered something that cannot hold a conversation: {ids:?}"
    );
    // `DeepSeek:deepseek-v4-flash`: with more than one key configured, a bare
    // model id does not say whose bill a turn goes on.
    assert_eq!(
        genet.catalog.models[0].label,
        format!(
            "DeepSeek:{}",
            genehub_testing::REAL_MODEL.split_once('/').unwrap().1
        )
    );

    journey.finish().await;
}

/// A provider we ship nothing for: someone's own gateway, a local llama.cpp, a
/// vendor we have never heard of. It needs an address, and then it is a provider
/// like any other — including in the picker.
#[tokio::test]
async fn a_provider_the_user_adds_works_like_the_ones_we_ship() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    let saved = match journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "inhouse".into(),
            api_key: Some("sk-inhouse".into()),
            base_url: Some(journey.mock().base_url.clone()),
            label: Some("公司内网".into()),
            dialect: Some("openai".into()),
            models: None,
        })
        .await
    {
        Ok(Reply::Settings(settings)) => settings,
        other => panic!("expected settings, got {other:?}"),
    };
    let added = saved
        .providers
        .iter()
        .find(|provider| provider.id == "inhouse")
        .expect("an added provider is listed");
    assert!(added.custom, "only ours are built in");
    assert_eq!(added.label, "公司内网");
    assert!(!added.models.is_empty(), "it was asked and it answered");

    let agents = match journey.client.call(Request::AgentRefresh).await.unwrap() {
        Reply::Agents(agents) => agents,
        other => panic!("unexpected {other:?}"),
    };
    let genet = agents.iter().find(|agent| agent.id == "genet").unwrap();
    assert!(
        genet
            .catalog
            .models
            .iter()
            .any(|model| model.label.starts_with("公司内网:")),
        "the added provider's models never reached the picker: {:?}",
        genet
            .catalog
            .models
            .iter()
            .map(|m| m.label.clone())
            .collect::<Vec<_>>()
    );

    // And it can be taken away again, which the built-in ones cannot: removing
    // `deepseek` would leave a row that reappears on the next start.
    journey
        .client
        .call(Request::SettingsForgetProvider {
            provider_id: "inhouse".into(),
        })
        .await
        .expect("an added provider can be removed");
    journey
        .client
        .expect_error(Request::SettingsForgetProvider {
            provider_id: "deepseek".into(),
        })
        .await;

    journey.finish().await;
}

/// An endpoint that cannot list its models — a bare llama.cpp, a proxy that only
/// forwards completions — is still usable, by writing the ids down. Without this
/// the picker for it is permanently empty and nothing explains why.
#[tokio::test]
async fn models_written_by_hand_need_no_list_call() {
    let journey = Journey::start().await.expect("journey starts");
    mock_only!(journey);

    let saved = match journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "local".into(),
            api_key: Some("none".into()),
            // Nothing listens here, and nothing needs to: the models are given.
            base_url: Some("http://127.0.0.1:9/v1".into()),
            label: Some("本地".into()),
            dialect: None,
            models: Some(vec!["qwen3-32b".into()]),
        })
        .await
    {
        Ok(Reply::Settings(settings)) => settings,
        other => panic!("expected settings, got {other:?}"),
    };
    let local = saved
        .providers
        .iter()
        .find(|provider| provider.id == "local")
        .expect("listed");
    assert_eq!(local.models, vec!["qwen3-32b".to_string()]);
    assert_eq!(
        local.problem, None,
        "nothing was asked, so there is nothing to complain about"
    );

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
        if !agent.capabilities.set_effort {
            let named: Vec<_> = agent
                .catalog
                .models
                .iter()
                .filter(|model| !model.efforts.is_empty())
                .map(|model| model.id.clone())
                .collect();
            assert!(
                named.is_empty(),
                "{} says it cannot set effort yet its models name levels: {named:?}",
                agent.id
            );
        }
    }

    journey.finish().await;
}

/// Thinking is its own axis. It used to ride on `mode`, which is where the
/// third-party agents keep their tool-approval policy — one field meaning two
/// unrelated things depending on which agent answered.
#[tokio::test]
async fn switching_the_thinking_level_takes_effect_on_the_built_in_agent() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("ok")).await;
    }
    let session = journey.session("genet").await.expect("session opens");
    journey.send(&session, "hello").await.expect("accepted");
    journey.client.drain_turn().await.expect("the turn ends");

    journey
        .client
        .call(Request::SessionSetEffort {
            session_id: session.clone(),
            effort_id: "low".into(),
        })
        .await
        .expect("the built-in agent has thinking levels");

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
    assert_eq!(snapshot.summary.effort_id.as_deref(), Some("low"));
    // And nothing landed on the other axis: a session that records its thinking
    // level as a *mode* is the confusion this split exists to end.
    assert_eq!(snapshot.summary.mode_id, None);

    journey.finish().await;
}

/// A picker draws itself from session state, so a choice that is only *stored*
/// looks like a choice that failed: the click lands, nothing says so, and the
/// next repaint puts the old value back. Which is what the chips did — visibly
/// springing back — because nothing announced a pick made before the first
/// prompt, and before the first prompt is when no agent process exists yet.
#[tokio::test]
async fn a_choice_made_before_the_first_prompt_is_announced_and_not_only_stored() {
    let journey = Journey::start().await.expect("journey starts");
    let session = journey.session("genet").await.expect("session opens");

    // Nothing sent yet: this is the ordinary case, not an edge one. The process
    // only starts when there is something to send.
    journey
        .client
        .call(Request::SessionSetEffort {
            session_id: session.clone(),
            effort_id: "high".into(),
        })
        .await
        .expect("a level can be chosen before saying anything");

    let announced = journey
        .client
        .wait_for(|event| matches!(event, SessionEvent::EffortChanged { .. }))
        .await
        .expect("the choice is announced to every client watching this session");
    assert!(
        matches!(&announced, SessionEvent::EffortChanged { effort_id } if effort_id == "high"),
        "saw {announced:?}"
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
    assert_eq!(snapshot.summary.effort_id.as_deref(), Some("high"));

    // And a value nobody offered is refused rather than stored, so a second
    // window does not repaint itself around something that never took.
    journey
        .client
        .call(Request::SessionSetEffort {
            session_id: session.clone(),
            effort_id: "as-hard-as-you-can".into(),
        })
        .await
        .expect_err("an unknown level is refused");

    journey.finish().await;
}

/// Sessions and clients from before the split named the level on the `mode`
/// axis, and reopening one of those must not silently drop back to the default.
#[tokio::test]
async fn the_built_in_agent_still_answers_to_the_old_name_for_thinking() {
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
            mode_id: "high".into(),
        })
        .await
        .expect("the old name still reaches the thinking level");

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
    // but the call must still reach the timeline. What it does not keep is the
    // raw frame — the access layer sheds everything but the card itself
    // (`session::overview`).
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
        ToolCallDetail::Overview {
            overview,
            input,
            output,
            ..
        } => {
            assert!(overview.chars().count() <= 64);
            assert!(input.lines().count() <= 1);
            assert!(input.chars().count() <= 64);
            assert!(output.lines().count() <= 5);
            assert!(output.lines().all(|line| line.chars().count() <= 64));
        }
        other => panic!("expected the bounded fallback renderer, got {other:?}"),
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
            label: None,
            dialect: None,
            models: None,
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
    // Saving a key is also what fills the picker: the reply already carries the
    // models that address reported. Anything else means the person has to guess
    // whether it worked, or hunt for a refresh.
    assert_eq!(
        provider.models,
        vec![genehub_testing::REAL_MODEL
            .split_once('/')
            .expect("the journey model names its provider")
            .1
            .to_string()],
        "the models the provider reported did not reach the settings reply"
    );
    assert_eq!(provider.problem, None);
    assert_eq!(provider.label, "DeepSeek");
    assert_eq!(
        provider.base_url.as_deref(),
        Some(journey.mock().base_url.as_str())
    );

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

/// A key that was given and refused.
///
/// The turn has to say what the provider said. Left to itself the agent says
/// "add an API key in settings" — to someone who just did that, which reads as
/// the app not having noticed. Covered in mock mode as well as against the real
/// thing below, because this is the message CI can check.
#[tokio::test]
async fn a_key_the_provider_will_not_accept_says_that_and_not_add_a_key() {
    let journey = Journey::start_with(genehub_testing::Mode::Mock, |config| {
        config.agents.providers.clear();
    })
    .await
    .expect("journey starts");
    mock_only!(journey);

    // A key, and an address where nothing is listening: the provider cannot be
    // asked what it has, which is the same shape as a refusal.
    journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "deepseek".into(),
            api_key: Some("sk-nope".into()),
            base_url: Some("http://127.0.0.1:9/v1".into()),
            label: None,
            dialect: None,
            models: None,
        })
        .await
        .expect("the key is stored");

    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "Say hello.")
        .await
        .expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn settles");

    let failure = events
        .failure()
        .expect("a turn with nothing to run on cannot look like success");
    assert!(
        failure.message.contains("deepseek"),
        "the failure does not name the provider that refused: {}",
        failure.message
    );
    assert!(
        !failure.message.contains("Add an API key"),
        "told to add a key they already added: {}",
        failure.message
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

    let saved = match journey
        .client
        .call(Request::SettingsSetProvider {
            provider_id: "deepseek".into(),
            api_key: Some("sk-0000000000000000000000000000000000000000".into()),
            // No address on purpose. DeepSeek is a provider we ship an address
            // for, and this is the case that used to send the key to
            // `api.openai.com` and blame the user for it.
            base_url: None,
            label: None,
            dialect: None,
            models: None,
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
        .expect("configured providers are listed");
    assert_eq!(
        provider.base_url.as_deref(),
        Some("https://api.deepseek.com/v1"),
        "a key saved for DeepSeek must be pointed at DeepSeek"
    );
    // The provider's own refusal, on the screen where the key was typed. This is
    // now where a revoked key shows up first: the picker stays empty because the
    // provider would not tell us what it has.
    let problem = provider
        .problem
        .as_deref()
        .expect("a rejected key has to say so somewhere");
    assert!(
        problem.contains("deepseek"),
        "the complaint does not name the provider: {problem}"
    );
    assert!(provider.models.is_empty());
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
async fn files_can_be_browsed_and_edited_through_the_workspace() {
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
async fn writes_outside_the_workspace_are_refused() {
    let journey = Journey::start().await.expect("journey starts");

    for path in ["../escape.txt", "/etc/passwd", "src/../../escape.txt"] {
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

/// Two hundred thousand lines of output is the extreme of an ordinary shape:
/// what the client needs is the command and that it ran, and the access layer
/// sheds the rest (`session::overview`) rather than streaming it to every
/// connected screen.
#[tokio::test]
async fn a_commands_output_stays_behind_the_access_layer() {
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
        ToolCallDetail::Overview {
            overview,
            input,
            output,
            ..
        } => {
            assert_eq!(overview, "seq 1 200000");
            assert_eq!(input, "seq 1 200000");
            assert!(output.lines().count() <= 5);
            assert!(output.lines().all(|line| line.chars().count() <= 64));
        }
        other => panic!("unexpected {other:?}"),
    }

    let snapshot = match journey
        .client
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: Some(0),
            expand_last_round: true,
        })
        .await
        .expect("layered session opens")
    {
        Reply::Subscribed {
            snapshot,
            replayed,
            reset,
        } => {
            assert!(reset);
            assert!(
                replayed.is_empty(),
                "historical tool output is not replayed beside the layered snapshot"
            );
            snapshot
        }
        other => panic!("unexpected {other:?}"),
    };
    assert!(snapshot.items.iter().all(|item| !matches!(
        item,
        TimelineItem::ToolCall { .. } | TimelineItem::Reasoning { .. }
    )));
    let expanded = snapshot
        .expanded_round
        .expect("the unread last round is prefetched");
    let blob_ref = expanded
        .expanded_trunk
        .expect("the last trunk is prefetched")
        .batches
        .into_iter()
        .flat_map(|batch| batch.blobs)
        .find(|blob| blob.kind == genehub_proto::BlobKind::ToolCall)
        .and_then(|blob| blob.blob)
        .expect("the tool overview addresses its source blob");
    let payload = match journey
        .client
        .call(Request::BlobGet {
            session_id: session.clone(),
            blob: blob_ref,
        })
        .await
        .expect("source blob is fetched on demand")
    {
        Reply::Blob(payload) => payload,
        other => panic!("unexpected {other:?}"),
    };
    let source_bytes = payload.value.to_string().len();
    assert!(
        source_bytes > 1_000,
        "the on-demand blob retains substantially more than the overview ({source_bytes} bytes)"
    );

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
    let reconnected = genehub_testing::Client::connect_loopback(journey.daemon())
        .await
        .expect("second connection");
    reconnected.hello("journey-2").await.expect("handshake");

    // Resuming from a real position, the way a client that saw the first
    // event and then dropped does. `sinceSeq: 0` is the "I have nothing"
    // signal a fresh open sends, and is answered with a snapshot instead.
    let (snapshot, replayed, reset) = match reconnected
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: Some(1),
            expand_last_round: false,
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

    let reconnected = genehub_testing::Client::connect_loopback(journey.daemon())
        .await
        .expect("second connection");
    reconnected.hello("journey-2").await.expect("handshake");

    match reconnected
        .call(Request::Subscribe {
            session_id: session,
            since_seq: Some(0),
            expand_last_round: false,
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
            expand_last_round: false,
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
            expand_last_round: false,
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

/// `continuesRound` travels the whole wire path — JSON, the router's
/// destructure, `SessionManager::send` — even though no client can yet learn
/// a real round id from the daemon (that lands with the round query API,
/// `docs/agent-analysis-substrate-proposal.md` §8). An id naming nothing the
/// daemon recognizes must be accepted exactly like no id at all, not
/// rejected: "no such round" is a normal answer to "this is a new one",
/// never a protocol error.
#[tokio::test]
async fn continues_round_is_accepted_over_the_wire_and_ignored_when_unrecognized() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("ok")).await;
    }
    let session = journey.session("genet").await.expect("session opens");

    journey
        .send_continuing(&session, "hello", Some("r_does_not_exist"))
        .await
        .expect("an unrecognized continuesRound must not be rejected");

    let events = journey.client.drain_turn().await.expect("the turn settles");
    assert!(events.completed(), "saw {:?}", events.failure());

    journey.finish().await;
}

/// After a stop, the session must keep working whether or not the client's
/// next message claims to continue the interrupted round — the daemon
/// decides what to do with the claim internally (fold in or supersede), but
/// either way the user's next message must go through normally.
#[tokio::test]
async fn a_message_naming_continues_round_after_an_interrupt_still_runs_normally() {
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
    let first = journey.client.drain_turn().await.expect("the turn settles");
    assert!(first.canceled(), "saw {:?}", first.last());

    if journey.mode.is_mock() {
        journey
            .mock()
            .reply(Turn::text("Picking up from there."))
            .await;
    }
    // The client cannot yet learn the real round id from the daemon (§8), so
    // this is necessarily a guess — and the daemon must treat an unrecognized
    // one exactly like no signal at all, per §3.2, rather than erroring or
    // wedging the session.
    journey
        .send_continuing(&session, "keep going", Some("r_whatever_the_ui_remembered"))
        .await
        .expect("accepted");
    let second = journey.client.drain_turn().await.expect("the turn settles");
    assert!(second.completed(), "saw {:?}", second.failure());

    journey.finish().await;
}

/// The round ledger (`docs/agent-analysis-substrate-proposal.md` §8 step 2)
/// exercised through the real wire protocol end to end, not just the
/// in-process unit tests in `apps/daemon/src/session/manager.rs`: a real
/// daemon, a real workspace, a real (mock) turn, then the file it wrote.
#[tokio::test]
async fn a_completed_round_is_recorded_in_the_round_ledger_on_disk() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey.mock().reply(Turn::text("ok")).await;
    }
    let session = journey.session("genet").await.expect("session opens");
    assert!(
        journey.round_records(&session).is_empty(),
        "no request has been made yet"
    );

    journey.send(&session, "hello").await.expect("accepted");
    let events = journey.client.drain_turn().await.expect("the turn settles");
    assert!(events.completed(), "saw {:?}", events.failure());

    let rounds = journey.round_records(&session);
    assert_eq!(
        rounds.len(),
        1,
        "the completed round must be ledgered exactly once"
    );
    assert_eq!(rounds[0]["outcome"], json!("completed"));
    assert_eq!(rounds[0]["synthesized"], json!(false));
    assert!(!rounds[0]["adapterTurnIds"]
        .as_array()
        .expect("an array of turn ids")
        .is_empty());
    assert!(
        rounds[0]["userItemId"].is_string(),
        "the round must name the message that opened it"
    );
    assert_eq!(
        rounds[0]["trunkCount"],
        json!(1),
        "the record counts trunks; the summaries themselves live in the round's own index"
    );

    // §3.2 direction three / §8 step 3: settling a round must close whatever
    // trunk was still open, so a short round that never crossed a boundary
    // still reports the one trunk it produced.
    let trunks = journey.trunk_summaries(&session, 0);
    assert_eq!(
        trunks.len(),
        1,
        "one short reply with no interruption produces exactly one trunk"
    );
    assert_eq!(trunks[0]["index"], json!(0));
    assert!(
        !trunks[0]["title"]
            .as_str()
            .expect("a trunk title is always a string")
            .is_empty(),
        "a trunk that opened with a monologue must not report a blank title"
    );
    assert!(
        !trunks[0]["batches"]
            .as_array()
            .expect("a trunk always carries its bounded batch index")
            .is_empty(),
        "a short trunk still has one visible batch"
    );

    journey.finish().await;
}

/// The other half of §3.2's four decision-table cases (the two auto-stitched
/// ones are covered against a fake adapter in `manager.rs`; this is the one
/// that needs a real turn boundary): an interrupt with no `continuesRound`
/// on the next message must ledger the abandoned round as `superseded`,
/// not silently drop it.
#[tokio::test]
async fn an_interrupted_round_left_dangling_is_ledgered_as_superseded_once_a_new_one_starts() {
    let journey = Journey::start().await.expect("journey starts");
    if journey.mode.is_mock() {
        journey
            .mock()
            .reply_slowly(
                Turn::text("A slow reply, so the interrupt lands mid-turn."),
                Duration::from_millis(400),
            )
            .await;
    }
    let session = journey.session("genet").await.expect("session opens");
    journey
        .send(&session, "count to 500")
        .await
        .expect("accepted");
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
    let first = journey.client.drain_turn().await.expect("the turn settles");
    assert!(first.canceled(), "saw {:?}", first.last());
    let dangling = journey.round_records(&session);
    assert_eq!(
        dangling.len(),
        1,
        "the round is on disk from the moment it opens"
    );
    assert_eq!(
        dangling[0]["outcome"],
        json!(null),
        "a merely interrupted round is left dangling, with no outcome yet"
    );

    if journey.mode.is_mock() {
        journey
            .mock()
            .reply(Turn::text("Unrelated new task."))
            .await;
    }
    // No `continuesRound`: a plain new message, so the dangling round must be
    // cut loose rather than guessed at (§3.2 direction zero).
    journey
        .send(&session, "something else entirely")
        .await
        .expect("accepted");
    let second = journey.client.drain_turn().await.expect("the turn settles");
    assert!(second.completed(), "saw {:?}", second.failure());

    let rounds = journey.round_records(&session);
    assert_eq!(
        rounds.len(),
        2,
        "the superseded round and the completed one that replaced it both ledger"
    );
    assert_eq!(rounds[0]["outcome"], json!("superseded"));
    assert_eq!(rounds[1]["outcome"], json!("completed"));

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
    let watching = genehub_testing::Client::connect_loopback(journey.daemon())
        .await
        .expect("a watching client");
    watching.hello("journey-2").await.expect("handshake");
    watching
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
            expand_last_round: false,
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

    let returning = genehub_testing::Client::connect_loopback(journey.daemon())
        .await
        .expect("reconnecting");
    returning.hello("journey-3").await.expect("handshake");
    let (snapshot, replayed, reset) = match returning
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: Some(seen_up_to),
            expand_last_round: false,
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

    let second = genehub_testing::Client::connect_loopback(journey.daemon())
        .await
        .expect("second connection");
    second.hello("journey-2").await.expect("handshake");
    second
        .call(Request::Subscribe {
            session_id: session.clone(),
            since_seq: None,
            expand_last_round: false,
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
async fn a_connection_without_the_token_is_rejected_outright() {
    let journey = Journey::start().await.expect("journey starts");
    let url = format!("ws://127.0.0.1:{}/ws?token=wrong", journey.daemon().port);
    assert!(
        tokio_tungstenite::connect_async(&url).await.is_err(),
        "the loopback port still needs its token"
    );
    journey.finish().await;
}

/// A malformed request must still be answered, or the caller waits forever for
/// a reply that has nowhere to go.
#[tokio::test]
async fn a_malformed_frame_gets_an_error_rather_than_silence() {
    let journey = Journey::start().await.expect("journey starts");
    let client = genehub_testing::Client::connect_loopback(journey.daemon())
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
            artifact_preview_base_url: None,
            continues_round: None,
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

/// A log has to be reachable from wherever the person is, which for a phone means
/// over the connection: a path under `%APPDATA%` is not something they can open.
/// Until now the only account of an agent crash was one sentence with no reason in
/// it, and the file that had the reason was unreachable and unmentioned.
#[tokio::test]
async fn the_log_can_be_read_from_whatever_device_saw_the_error() {
    let journey = Journey::start().await.expect("journey starts");

    // The daemon logs to this file; in-process tests do not install a subscriber,
    // so the line under test is the serving, not the writing.
    std::fs::create_dir_all(journey.logs_dir()).expect("the log directory is there");
    std::fs::write(
        journey.logs_dir().join("daemon.log"),
        "INFO listening\nWARN claude: Invalid API key\n",
    )
    .expect("a log to read");

    let reply = journey
        .client
        .call(Request::LogTail { name: None })
        .await
        .expect("the log comes back");
    let Reply::Log(log) = reply else {
        panic!("not a log: {reply:?}");
    };
    assert!(
        log.text.contains("Invalid API key"),
        "the log is missing what it was opened for: {}",
        log.text
    );
    assert_eq!(log.name, "daemon.log");
    assert!(
        log.files.iter().any(|file| file.name == "daemon.log"),
        "the listing does not mention the file it just served"
    );
}

/// Anyone paired with this machine can ask for a log. That is a diagnostic, not a
/// way to read the disk, and the difference is one `..` away.
#[tokio::test]
async fn a_log_request_cannot_reach_outside_the_log_directory() {
    let journey = Journey::start().await.expect("journey starts");

    for attempt in ["../config.json", "../../.ssh/id_rsa"] {
        let refused = journey
            .client
            .call(Request::LogTail {
                name: Some(attempt.into()),
            })
            .await;
        assert!(refused.is_err(), "{attempt} was served");
    }
}
