//! Opt-in concurrency journeys for the signed Wasm application.
//!
//! These are measurements, not mocks of the scheduler. They retain the real
//! daemon, Wasmtime instance, encrypted data plane, files, process driver and
//! `genet agent` children. Only the paid model endpoint is replaced.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use futures_util::future::join_all;
use genehub_proto::{BlobKind, Reply, Request, SessionEvent, TimelineItem, WorkspaceInfo};
use genehub_testing::{Client, EventsExt, Journey, MockLlm, MockWorkloadProfile};
use serde::Serialize;

const PREVIEW_BYTES: usize = 64 * 1024;
const BACKPRESSURE_PREVIEW_BYTES: usize = 256 * 1024;
const MAX_OBSERVER_SUBSCRIPTIONS: usize = 64;
const TURN_TIMEOUT: Duration = Duration::from_secs(180);

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[derive(Clone, Copy)]
struct Profile {
    name: &'static str,
    workspaces: usize,
    analyses_per_workspace: usize,
    browsers: usize,
    poll_pause: Duration,
}

impl Profile {
    fn selected() -> Result<Self> {
        match std::env::var("GENET_CONCURRENCY_PROFILE")
            .unwrap_or_else(|_| "moderate".to_string())
            .as_str()
        {
            "moderate" => Ok(Self {
                name: "moderate",
                workspaces: 10,
                analyses_per_workspace: 1,
                browsers: 4,
                poll_pause: Duration::from_millis(20),
            }),
            "heavy" => Ok(Self {
                name: "heavy",
                workspaces: 20,
                analyses_per_workspace: 2,
                browsers: 8,
                poll_pause: Duration::from_millis(10),
            }),
            "max" => Ok(Self {
                name: "max",
                workspaces: 20,
                analyses_per_workspace: 3,
                browsers: 8,
                poll_pause: Duration::from_millis(10),
            }),
            "max-isolated" => Ok(Self {
                name: "max-isolated",
                workspaces: 20,
                analyses_per_workspace: 3,
                browsers: 0,
                poll_pause: Duration::from_millis(10),
            }),
            "saturation" => Ok(Self {
                name: "saturation",
                workspaces: 20,
                analyses_per_workspace: 3,
                browsers: 8,
                poll_pause: Duration::ZERO,
            }),
            other => bail!("unknown GENET_CONCURRENCY_PROFILE {other:?}"),
        }
    }

    fn agents(self) -> usize {
        self.workspaces * (1 + self.analyses_per_workspace)
    }
}

#[derive(Debug, Clone)]
struct Sample {
    operation: &'static str,
    elapsed: Duration,
    failed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LatencySummary {
    count: usize,
    failures: usize,
    over_3s: usize,
    min_ms: f64,
    p50_ms: f64,
    p95_ms: f64,
    p99_ms: f64,
    max_ms: f64,
}

impl LatencySummary {
    fn durations(values: impl IntoIterator<Item = Duration>, failures: usize) -> Self {
        let values = values.into_iter().collect::<Vec<_>>();
        let over_3s = values
            .iter()
            .filter(|duration| **duration > Duration::from_secs(3))
            .count();
        let mut micros: Vec<u64> = values
            .into_iter()
            .map(|duration| duration.as_micros().min(u128::from(u64::MAX)) as u64)
            .collect();
        micros.sort_unstable();
        let value = |percent: usize| -> f64 {
            if micros.is_empty() {
                return 0.0;
            }
            let index = ((micros.len() - 1) * percent).div_ceil(100);
            micros[index] as f64 / 1_000.0
        };
        Self {
            count: micros.len(),
            failures,
            over_3s,
            min_ms: micros.first().copied().unwrap_or_default() as f64 / 1_000.0,
            p50_ms: value(50),
            p95_ms: value(95),
            p99_ms: value(99),
            max_ms: micros.last().copied().unwrap_or_default() as f64 / 1_000.0,
        }
    }

    fn samples(values: &[Sample]) -> Self {
        Self::durations(
            values.iter().map(|sample| sample.elapsed),
            values.iter().filter(|sample| sample.failed).count(),
        )
    }
}

#[test]
fn latency_summary_counts_only_operations_strictly_over_three_seconds() {
    let summary = LatencySummary::durations(
        [
            Duration::from_millis(2_999),
            Duration::from_millis(3_000),
            Duration::from_millis(3_001),
            Duration::from_secs(5),
        ],
        0,
    );
    assert_eq!(summary.count, 4);
    assert_eq!(summary.over_3s, 2);
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadReport {
    profile: String,
    mock_workload: MockWorkloadReport,
    logical_cpus: usize,
    workspaces: usize,
    analyses_per_workspace: usize,
    agents: usize,
    browsers: usize,
    cold_agent_catalog_ms: f64,
    workspace_setup_ms: f64,
    collector_subscription_ms: f64,
    browser_subscription_ms: f64,
    session_start: LatencySummary,
    cold_turn: TurnPhaseReport,
    warm_turn: TurnPhaseReport,
    passive_reader_turn: TurnPhaseReport,
    owner_only_turn: TurnPhaseReport,
    interaction_requests: BTreeMap<String, LatencySummary>,
    initial_native_resources: Option<u32>,
    after_cold_native_resources: Option<u32>,
    retained_native_resources: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MockWorkloadReport {
    profile: String,
    tool_rounds_per_turn: usize,
    tool_calls_per_turn: usize,
    model_requests_per_turn: usize,
    sse_frame_gap_ms: f64,
    expected_model_requests: usize,
    observed_model_requests: usize,
    model_request_body_bytes: ByteSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ByteSummary {
    count: usize,
    total: u64,
    min: usize,
    p50: usize,
    p95: usize,
    p99: usize,
    max: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PhaseFailureReport {
    profile: String,
    mock_workload: String,
    phase: &'static str,
    observed_model_requests: usize,
    model_request_body_bytes: ByteSummary,
    error: String,
}

impl ByteSummary {
    fn from_values(values: &[usize]) -> Self {
        let mut sorted = values.to_vec();
        sorted.sort_unstable();
        let percentile = |percent: usize| {
            if sorted.is_empty() {
                return 0;
            }
            sorted[((sorted.len() - 1) * percent).div_ceil(100)]
        };
        Self {
            count: sorted.len(),
            total: sorted.iter().map(|value| *value as u64).sum(),
            min: sorted.first().copied().unwrap_or_default(),
            p50: percentile(50),
            p95: percentile(95),
            p99: percentile(99),
            max: sorted.last().copied().unwrap_or_default(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnPhaseReport {
    prompt_ack: LatencySummary,
    turn_completion: LatencySummary,
    total_turn_wall_ms: f64,
    completed_turns_per_second: f64,
    owner_event_count: usize,
    tool_detail_events: usize,
}

struct TurnPhaseMeasurement {
    prompt_ack: Vec<Duration>,
    turn_completion: Vec<Duration>,
    total_turn_wall: Duration,
    owner_event_count: usize,
    tool_detail_events: usize,
}

impl TurnPhaseMeasurement {
    fn report(self, agents: usize) -> TurnPhaseReport {
        TurnPhaseReport {
            prompt_ack: LatencySummary::durations(self.prompt_ack, 0),
            turn_completion: LatencySummary::durations(self.turn_completion, 0),
            total_turn_wall_ms: millis(self.total_turn_wall),
            completed_turns_per_second: agents as f64 / self.total_turn_wall.as_secs_f64(),
            owner_event_count: self.owner_event_count,
            tool_detail_events: self.tool_detail_events,
        }
    }
}

#[derive(Clone)]
struct SessionSpec {
    workspace_id: String,
    label: String,
}

#[derive(Clone)]
struct SessionView {
    id: String,
    workspace_id: String,
    root_handle: String,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
#[ignore = "opt-in real daemon/Wasm concurrency measurement; see docs/testing.md"]
async fn concurrent_user_journey_matches_profile() -> Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter("genet_daemon::dataplane=debug")
        .with_test_writer()
        .try_init();
    let _serial = serial().lock().await;
    let profile = Profile::selected()?;
    let mock_profile = std::env::var("GENET_CONCURRENCY_MOCK_PROFILE")
        .unwrap_or_else(|_| MockWorkloadProfile::default().name().to_string())
        .parse::<MockWorkloadProfile>()
        .map_err(anyhow::Error::msg)?;
    let journey = Journey::start()
        .await
        .context("starting concurrency journey")?;

    // A real workbench loads the Agent picker before it can create a task.
    // Keep that cold, potentially slow discovery visible as its own metric,
    // but do not charge it again to every first prompt.
    let catalog_started = Instant::now();
    if !matches!(
        journey
            .client
            .call(Request::AgentList)
            .await
            .context("warming Agent catalog for canaries")?,
        Reply::Agents(_)
    ) {
        bail!("agent.list returned the wrong reply");
    }
    let cold_agent_catalog = catalog_started.elapsed();

    let workspace_started = Instant::now();
    let mut workspaces = Vec::with_capacity(profile.workspaces);
    for index in 0..profile.workspaces {
        let workspace = journey
            .additional_workspace(&format!("concurrency-{index:02}"))
            .await?;
        write_workload_fixture(Path::new(&workspace.root), index)?;
        workspaces.push(workspace);
    }
    let workspace_setup = workspace_started.elapsed();

    let mut specs = Vec::with_capacity(profile.agents());
    for (workspace_index, workspace) in workspaces.iter().enumerate() {
        specs.push(SessionSpec {
            workspace_id: workspace.id.clone(),
            label: format!("workspace-{workspace_index:02}-main"),
        });
        for analysis in 0..profile.analyses_per_workspace {
            specs.push(SessionSpec {
                workspace_id: workspace.id.clone(),
                label: format!("workspace-{workspace_index:02}-analysis-{analysis}"),
            });
        }
    }

    let model_id = journey.model_id();
    let created = join_all(specs.iter().map(|spec| {
        let model_id = model_id.clone();
        async {
            let started = Instant::now();
            let reply = journey
                .client
                .call(Request::SessionCreate {
                    workspace_id: spec.workspace_id.clone(),
                    agent_id: "genet".to_string(),
                    model_id: Some(model_id),
                    mode_id: None,
                    runtime_values: None,
                    title: Some(spec.label.clone()),
                    cwd: None,
                })
                .await;
            (started.elapsed(), reply)
        }
    }))
    .await;
    let mut session_start = Vec::with_capacity(created.len());
    let mut session_ids = Vec::with_capacity(created.len());
    for (elapsed, reply) in created {
        session_start.push(elapsed);
        match reply? {
            Reply::Session(session) => session_ids.push(session.id),
            other => bail!("session.create returned {other:?}"),
        }
    }

    // One encrypted peer can retain at most 64 session subscriptions. Use
    // additional observation peers instead of silently assuming a single UI
    // receives completion events for an arbitrary number of tasks.
    let collector_started = Instant::now();
    let mut collectors = Vec::new();
    for (index, chunk) in session_ids.chunks(MAX_OBSERVER_SUBSCRIPTIONS).enumerate() {
        let collector = Client::connect_loopback(journey.daemon()).await?;
        collector.hello(&format!("turn-collector-{index}")).await?;
        let subscriptions = join_all(chunk.iter().map(|session_id| {
            collector.call(Request::Subscribe {
                session_id: session_id.clone(),
                since_seq: None,
                expand_last_round: false,
                recent_rounds: None,
            })
        }))
        .await;
        for subscribed in subscriptions {
            if !matches!(subscribed?, Reply::Subscribed { .. }) {
                bail!("turn collector subscribe returned the wrong reply");
            }
        }
        collectors.push(collector);
    }
    let collector_subscription = collector_started.elapsed();

    let workspace_by_id: HashMap<&str, &WorkspaceInfo> = workspaces
        .iter()
        .map(|workspace| (workspace.id.as_str(), workspace))
        .collect();
    let session_views: Arc<Vec<SessionView>> = Arc::new(
        session_ids
            .iter()
            .zip(specs.iter())
            .map(|(id, spec)| {
                let workspace = workspace_by_id[spec.workspace_id.as_str()];
                SessionView {
                    id: id.clone(),
                    workspace_id: spec.workspace_id.clone(),
                    root_handle: workspace.folders[0].root_handle.clone(),
                }
            })
            .collect(),
    );

    let browser_started = Instant::now();
    let mut browsers = Vec::with_capacity(profile.browsers);
    let mut browser_sessions = Vec::with_capacity(profile.browsers);
    for browser_index in 0..profile.browsers {
        let client = Client::connect_loopback(journey.daemon()).await?;
        client.hello(&format!("browser-{browser_index}")).await?;
        // A workbench keeps the current tab warm. Opening another session
        // subscribes it before evicting the previous one, so every measured
        // `session.open` below includes the snapshot the real UI waits for
        // without turning one browser into an unrealistic 64-session fanout.
        let offset = (browser_index * 17) % session_ids.len();
        let session_id = session_ids[offset].clone();
        if !matches!(
            client
                .call(Request::Subscribe {
                    session_id: session_id.clone(),
                    since_seq: None,
                    expand_last_round: true,
                    recent_rounds: None,
                })
                .await?,
            Reply::Subscribed { .. }
        ) {
            bail!("browser subscribe returned the wrong reply");
        }
        browsers.push(Arc::new(client));
        browser_sessions.push(session_id);
    }
    let browser_subscription = browser_started.elapsed();

    let model_requests_before = journey.mock().request_count().await;
    journey.mock().repeat_workload(mock_profile).await;

    let stopped = Arc::new(AtomicBool::new(false));
    let ui_samples = Arc::new(Mutex::new(Vec::<Sample>::new()));
    let mut pollers = Vec::new();
    for ((index, browser), session_id) in browsers.iter().enumerate().zip(browser_sessions) {
        pollers.push(tokio::spawn(poll_browser(
            index,
            Arc::clone(browser),
            Arc::clone(&session_views),
            session_id,
            Arc::clone(&stopped),
            Arc::clone(&ui_samples),
            profile.poll_pause,
        )));
    }

    // Old private Wasmtime counter no longer exists; never report a fabricated zero.
    let initial_native_resources = None;
    let cold_turn = run_turn_phase_with_diagnostics(
        &journey.client,
        &collectors,
        &session_ids,
        "cold",
        journey.mock(),
        model_requests_before,
        profile.name,
        mock_profile,
    )
    .await?;
    // Old private Wasmtime counter no longer exists; never report a fabricated zero.
    let after_cold_native_resources = None;
    let warm_turn = run_turn_phase_with_diagnostics(
        &journey.client,
        &collectors,
        &session_ids,
        "warm",
        journey.mock(),
        model_requests_before,
        profile.name,
        mock_profile,
    )
    .await?;

    // Keep every event subscription alive but remove active browser reads.
    // This separates publication fanout from polling requests competing for
    // the resident application's one execution turn.
    stopped.store(true, Ordering::Release);
    for poller in pollers {
        poller.await.context("browser poller panicked")??;
    }
    let passive_reader_turn = run_turn_phase_with_diagnostics(
        &journey.client,
        &collectors,
        &session_ids,
        "passive-reader",
        journey.mock(),
        model_requests_before,
        profile.name,
        mock_profile,
    )
    .await?;

    // Finally remove the browser subscriptions as well. The same live Agent
    // processes now expose the resident event/capability floor by themselves.
    for browser in browsers.drain(..) {
        let client = Arc::try_unwrap(browser)
            .map_err(|_| anyhow::anyhow!("browser client still has an owner"))?;
        client.close().await;
    }
    let owner_only_turn = run_turn_phase_with_diagnostics(
        &journey.client,
        &collectors,
        &session_ids,
        "owner-only",
        journey.mock(),
        model_requests_before,
        profile.name,
        mock_profile,
    )
    .await?;
    let observed_model_requests = journey
        .mock()
        .request_count()
        .await
        .saturating_sub(model_requests_before);
    let all_request_body_bytes = journey.mock().request_body_bytes().await;
    let workload_request_body_bytes = all_request_body_bytes
        .get(model_requests_before..)
        .unwrap_or_default();
    journey.mock().clear_repeated().await;

    // Old private Wasmtime counter no longer exists; never report a fabricated zero.
    let retained_native_resources = None;
    let grouped = group_samples(&ui_samples.lock().expect("UI sample lock poisoned"));
    let phase_count = 4;
    let expected_model_requests =
        profile.agents() * phase_count * mock_profile.model_requests_per_turn();
    let report = LoadReport {
        profile: profile.name.to_string(),
        mock_workload: MockWorkloadReport {
            profile: mock_profile.name().to_string(),
            tool_rounds_per_turn: mock_profile.tool_rounds(),
            tool_calls_per_turn: mock_profile.tool_calls_per_turn(),
            model_requests_per_turn: mock_profile.model_requests_per_turn(),
            sse_frame_gap_ms: millis(mock_profile.frame_gap()),
            expected_model_requests,
            observed_model_requests,
            model_request_body_bytes: ByteSummary::from_values(workload_request_body_bytes),
        },
        logical_cpus: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        workspaces: profile.workspaces,
        analyses_per_workspace: profile.analyses_per_workspace,
        agents: profile.agents(),
        browsers: profile.browsers,
        cold_agent_catalog_ms: millis(cold_agent_catalog),
        workspace_setup_ms: millis(workspace_setup),
        collector_subscription_ms: millis(collector_subscription),
        browser_subscription_ms: millis(browser_subscription),
        session_start: LatencySummary::durations(session_start, 0),
        cold_turn: cold_turn.report(profile.agents()),
        warm_turn: warm_turn.report(profile.agents()),
        passive_reader_turn: passive_reader_turn.report(profile.agents()),
        owner_only_turn: owner_only_turn.report(profile.agents()),
        interaction_requests: grouped,
        initial_native_resources,
        after_cold_native_resources,
        retained_native_resources,
    };
    emit_report(
        "load",
        &format!("{}-{}", profile.name, mock_profile.name()),
        &report,
    )?;

    assert_eq!(
        report.cold_turn.turn_completion.count,
        profile.agents(),
        "every cold Agent turn must settle"
    );
    assert_eq!(
        report.warm_turn.turn_completion.count,
        profile.agents(),
        "every warm Agent turn must settle"
    );
    assert!(
        [
            &report.cold_turn,
            &report.warm_turn,
            &report.passive_reader_turn,
            &report.owner_only_turn,
        ]
        .into_iter()
        .all(|turn| turn.turn_completion.count == profile.agents()
            && turn.tool_detail_events >= profile.agents() * mock_profile.tool_calls_per_turn()),
        "every phase must settle and expose every configured tool call"
    );
    assert_eq!(
        report.mock_workload.observed_model_requests, report.mock_workload.expected_model_requests,
        "every Agent phase must execute the configured model/tool loop"
    );
    assert_eq!(
        report.mock_workload.model_request_body_bytes.count,
        report.mock_workload.observed_model_requests,
        "every observed model request must carry a measured request body"
    );
    assert!(
        report
            .interaction_requests
            .values()
            .all(|summary| summary.failures == 0),
        "session/detail/preview interactions must not fail under load"
    );
    if profile.browsers > 0 {
        for operation in [
            "session.list",
            "session.open",
            "file.tree",
            "asset.preview",
            "round.trunk.list",
            "round.trunk.get",
            "tool.detail",
        ] {
            assert!(
                report
                    .interaction_requests
                    .get(operation)
                    .is_some_and(|summary| summary.count > 0),
                "the user journey did not exercise {operation}"
            );
        }
    }

    for collector in collectors {
        collector.close().await;
    }
    journey.finish().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn run_turn_phase_with_diagnostics(
    sender: &Client,
    collectors: &[Client],
    session_ids: &[String],
    phase: &'static str,
    mock: &MockLlm,
    model_requests_before: usize,
    profile: &str,
    mock_profile: MockWorkloadProfile,
) -> Result<TurnPhaseMeasurement> {
    match run_turn_phase(sender, collectors, session_ids, phase).await {
        Ok(measurement) => Ok(measurement),
        Err(error) => {
            let all_request_body_bytes = mock.request_body_bytes().await;
            let workload_request_body_bytes = all_request_body_bytes
                .get(model_requests_before..)
                .unwrap_or_default();
            let report = PhaseFailureReport {
                profile: profile.to_string(),
                mock_workload: mock_profile.name().to_string(),
                phase,
                observed_model_requests: workload_request_body_bytes.len(),
                model_request_body_bytes: ByteSummary::from_values(workload_request_body_bytes),
                error: format!("{error:#}"),
            };
            eprintln!(
                "GENEHUB_CONCURRENCY_failure:\n{}",
                serde_json::to_string_pretty(&report)?
            );
            Err(error)
        }
    }
}

fn write_workload_fixture(root: &Path, index: usize) -> Result<()> {
    for directory in ["src", "tests", "docs", "data"] {
        std::fs::create_dir_all(root.join(directory))?;
    }

    let mut notes = format!("# Workspace {index}\n\n");
    notes
        .push_str(&"preview fixture line\n".repeat(
            PREVIEW_BYTES.saturating_sub(notes.len()) / "preview fixture line\n".len() + 1,
        ));
    notes.truncate(PREVIEW_BYTES);
    std::fs::write(root.join("notes.md"), notes)?;
    std::fs::write(
        root.join("task.txt"),
        format!(
            "Investigate workspace {index}; collect evidence from code, tests, and documentation.\n"
        ),
    )?;

    let readme = format!(
        "# Capacity fixture {index}\n\n{}",
        "This repository exercises a realistic read-search-shell Agent loop.\n".repeat(160)
    );
    std::fs::write(root.join("README.md"), readme)?;

    let lib = (0..420)
        .map(|line| {
            format!("pub fn workload_{line:03}() -> usize {{ {line} }} // GENEHUB_LOAD_MARKER\n")
        })
        .collect::<String>();
    std::fs::write(root.join("src/lib.rs"), lib)?;

    let main = (0..180)
        .map(|line| format!("fn stage_{line:03}() {{ let _sample = {line}; }}\n"))
        .collect::<String>();
    std::fs::write(root.join("src/main.rs"), main)?;

    let workflow = (0..180)
        .map(|line| {
            format!(
                "#[test] fn journey_{line:03}() {{ assert_eq!({line} + 1, {}); }}\n",
                line + 1
            )
        })
        .collect::<String>();
    std::fs::write(root.join("tests/workflow.rs"), workflow)?;

    let design = format!(
        "# Architecture\n\n{}",
        "The architecture keeps policy in Wasm and bounded OS capabilities in native code.\n"
            .repeat(260)
    );
    std::fs::write(root.join("docs/design.md"), design)?;

    let deep_context = (0..1_600)
        .map(|line| {
            format!(
                "evidence-{line:04}: concurrent Agent history, tool detail, preview, and event fanout\n"
            )
        })
        .collect::<String>();
    std::fs::write(root.join("data/deep-context.txt"), deep_context)?;
    Ok(())
}

async fn run_turn_phase(
    sender: &Client,
    collectors: &[Client],
    session_ids: &[String],
    phase: &'static str,
) -> Result<TurnPhaseMeasurement> {
    let turn_started = Instant::now();
    let prompt_results = join_all(session_ids.iter().map(|session_id| {
        let session_id = session_id.clone();
        async move {
            let started = Instant::now();
            let reply = sender
                .call(Request::SessionSend {
                    message_id: None,
                    task_run_id: None,
                    text: format!(
                        "Investigate the fixture and report evidence for {phase} task {session_id}."
                    ),
                    session_id,
                    attachments: Vec::new(),
                    artifact_preview_base_url: None,
                    continues_round: None,
                })
                .await;
            (started.elapsed(), reply)
        }
    }))
    .await;
    let mut prompt_ack = Vec::with_capacity(prompt_results.len());
    for (elapsed, reply) in prompt_results {
        prompt_ack.push(elapsed);
        reply?;
    }

    let collected = join_all(
        collectors
            .iter()
            .zip(session_ids.chunks(MAX_OBSERVER_SUBSCRIPTIONS))
            .map(|(collector, sessions)| collect_turns(collector, sessions, turn_started)),
    )
    .await;
    let mut turn_completion = Vec::with_capacity(session_ids.len());
    let mut owner_event_count = 0_usize;
    let mut tool_detail_events = 0_usize;
    for result in collected {
        let (mut completion, events, tools) =
            result.with_context(|| format!("{phase} turn phase did not settle"))?;
        turn_completion.append(&mut completion);
        owner_event_count += events;
        tool_detail_events += tools;
    }
    Ok(TurnPhaseMeasurement {
        prompt_ack,
        turn_completion,
        total_turn_wall: turn_started.elapsed(),
        owner_event_count,
        tool_detail_events,
    })
}

async fn poll_browser(
    browser_index: usize,
    client: Arc<Client>,
    sessions: Arc<Vec<SessionView>>,
    mut current_session_id: String,
    stopped: Arc<AtomicBool>,
    samples: Arc<Mutex<Vec<Sample>>>,
    pause: Duration,
) -> Result<()> {
    let mut iteration = 0_usize;
    while !stopped.load(Ordering::Acquire) {
        let session = &sessions[(browser_index + iteration + 1) % sessions.len()];

        if !matches!(
            sampled_call(
                &client,
                &samples,
                "session.list",
                Request::SessionList {
                    workspace_id: None,
                    include_archived: false,
                },
            )
            .await?,
            Reply::Sessions(_)
        ) {
            bail!("session.list returned the wrong reply");
        }

        // This is the network part of opening a conversation that is not
        // already kept warm in a tab: the real workbench subscribes and waits
        // for a snapshot with the latest round prefetched.
        let opened = sampled_call(
            &client,
            &samples,
            "session.open",
            Request::Subscribe {
                session_id: session.id.clone(),
                since_seq: None,
                expand_last_round: true,
                recent_rounds: None,
            },
        )
        .await?;
        let snapshot = match opened {
            Reply::Subscribed { snapshot, .. } => snapshot,
            other => bail!("session.open returned {other:?}"),
        };
        if current_session_id != session.id {
            if !matches!(
                client
                    .call(Request::Unsubscribe {
                        session_id: current_session_id.clone(),
                    })
                    .await?,
                Reply::Ack
            ) {
                bail!("unsubscribe returned the wrong reply");
            }
            current_session_id.clone_from(&session.id);
        }

        // Opening a round card and then an older trunk are distinct user
        // operations. The final trunk may already be in the subscription
        // snapshot, but an older card still uses these exact RPCs.
        if let Some(round) = snapshot
            .rounds
            .as_ref()
            .and_then(|rounds| rounds.iter().rev().find(|round| round.trunk_count > 0))
        {
            let listed = sampled_call(
                &client,
                &samples,
                "round.trunk.list",
                Request::RoundTrunkList {
                    session_id: session.id.clone(),
                    round_id: round.round_id.clone(),
                    cursor: None,
                    limit: Some(20),
                },
            )
            .await?;
            let layer = match listed {
                Reply::RoundLayer(layer) => layer,
                other => bail!("round.trunk.list returned {other:?}"),
            };
            if let Some(summary) = layer
                .trunks
                .iter()
                .rev()
                .find(|summary| summary.blob_count > 0)
            {
                let detail = sampled_call(
                    &client,
                    &samples,
                    "round.trunk.get",
                    Request::RoundTrunkGet {
                        session_id: session.id.clone(),
                        round_id: round.round_id.clone(),
                        trunk_index: summary.index,
                    },
                )
                .await?;
                let trunk = match detail {
                    Reply::RoundTrunk(trunk) => trunk,
                    other => bail!("round.trunk.get returned {other:?}"),
                };
                if let Some(blob) = trunk
                    .batches
                    .iter()
                    .flat_map(|batch| &batch.blobs)
                    .find(|blob| matches!(blob.kind, BlobKind::ToolCall))
                    .and_then(|blob| blob.blob.clone())
                {
                    if !matches!(
                        sampled_call(
                            &client,
                            &samples,
                            "tool.detail",
                            Request::BlobGet {
                                session_id: session.id.clone(),
                                blob,
                            },
                        )
                        .await?,
                        Reply::Blob(_)
                    ) {
                        bail!("tool.detail returned the wrong reply");
                    }
                }
            }
        }

        if !matches!(
            sampled_call(
                &client,
                &samples,
                "file.tree",
                Request::FileTree {
                    workspace_id: session.workspace_id.clone(),
                    path: None,
                    depth: Some(2),
                },
            )
            .await?,
            Reply::FileTree(_)
        ) {
            bail!("file.tree returned the wrong reply");
        }

        let path = format!("{}/notes.md", session.root_handle);
        let started = Instant::now();
        let preview = client.preview(&session.workspace_id, &path).await;
        record_sample(
            &samples,
            Sample {
                operation: "asset.preview",
                elapsed: started.elapsed(),
                failed: !matches!(&preview, Ok((head, _)) if head.status == 200),
            },
        );
        preview.context("asset.preview failed")?;

        iteration += 1;
        if !pause.is_zero() {
            tokio::time::sleep(pause).await;
        } else {
            tokio::task::yield_now().await;
        }
    }
    Ok(())
}

async fn sampled_call(
    client: &Client,
    samples: &Arc<Mutex<Vec<Sample>>>,
    operation: &'static str,
    request: Request,
) -> Result<Reply> {
    let started = Instant::now();
    let result = client.call(request).await;
    record_sample(
        samples,
        Sample {
            operation,
            elapsed: started.elapsed(),
            failed: result.is_err(),
        },
    );
    result
}

fn record_sample(samples: &Arc<Mutex<Vec<Sample>>>, sample: Sample) {
    samples
        .lock()
        .expect("UI sample lock poisoned")
        .push(sample);
}

async fn collect_turns(
    client: &Client,
    session_ids: &[String],
    started: Instant,
) -> Result<(Vec<Duration>, usize, usize)> {
    let mut pending: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let mut completed = Vec::with_capacity(session_ids.len());
    let mut events_seen = 0_usize;
    let mut tool_details = 0_usize;
    let deadline = tokio::time::Instant::now() + TURN_TIMEOUT;
    let mut events = client.events.lock().await;
    while !pending.is_empty() {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            bail!("{} concurrent Agent turns did not settle", pending.len());
        }
        let event = match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Some(event)) => event,
            Ok(None) => bail!(
                "owner event stream closed with {} concurrent Agent turns pending",
                pending.len()
            ),
            Err(_) => bail!(
                "{} concurrent Agent turns did not settle before the {:?} phase deadline",
                pending.len(),
                TURN_TIMEOUT
            ),
        };
        if !pending.contains(event.session_id.as_str()) {
            continue;
        }
        events_seen += 1;
        if matches!(
            &event.event,
            SessionEvent::Item {
                item: TimelineItem::ToolCall { .. },
                ..
            }
        ) {
            tool_details += 1;
        }
        match event.event {
            SessionEvent::TurnCompleted { .. } => {
                pending.remove(event.session_id.as_str());
                completed.push(started.elapsed());
            }
            SessionEvent::TurnFailed { error, .. } => {
                bail!("Agent turn {} failed: {error:?}", event.session_id)
            }
            SessionEvent::TurnCanceled { .. } => {
                bail!("Agent turn {} was canceled", event.session_id)
            }
            _ => {}
        }
    }
    Ok((completed, events_seen, tool_details))
}

fn group_samples(samples: &[Sample]) -> BTreeMap<String, LatencySummary> {
    let mut grouped: BTreeMap<String, Vec<Sample>> = BTreeMap::new();
    for sample in samples {
        grouped
            .entry(sample.operation.to_string())
            .or_default()
            .push(sample.clone());
    }
    grouped
        .into_iter()
        .map(|(operation, samples)| (operation, LatencySummary::samples(&samples)))
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CanaryReport {
    logical_cpus: usize,
    slow_model_turn_ms: f64,
    slow_model_unrelated: LatencySummary,
    slow_git_request_ms: f64,
    slow_git_unrelated_read_ms: f64,
    slow_git_unrelated_capability_ms: f64,
    flowing_browser_unrelated_ms: f64,
    paused_browser_unrelated_ms: f64,
    paused_browser_amplification: f64,
    paused_browser_timed_out: bool,
    preview_flood_requests: usize,
    preview_flood_workers: usize,
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 16)]
#[ignore = "opt-in causal contention probes; see docs/testing.md"]
async fn blocking_canaries_locate_the_global_stall() -> Result<()> {
    use std::os::unix::fs::PermissionsExt;

    let _ = tracing_subscriber::fmt()
        .with_env_filter("genet_daemon::dataplane=debug")
        .with_test_writer()
        .try_init();
    let _serial = serial().lock().await;
    let journey = Journey::start().await.context("starting canary journey")?;
    let control = Arc::new(Client::connect_loopback(journey.daemon()).await?);
    control.hello("canary-control").await?;
    let git_control = Arc::new(Client::connect_loopback(journey.daemon()).await?);
    git_control.hello("canary-git").await?;
    let capability_control = Arc::new(Client::connect_loopback(journey.daemon()).await?);
    capability_control.hello("canary-capability").await?;
    if !matches!(
        journey.client.call(Request::AgentList).await?,
        Reply::Agents(_)
    ) {
        bail!("agent.list returned the wrong reply");
    }

    // Negative control: the slow HTTP stream belongs to the child Agent's own
    // Wasm instance. It should leave resident daemon reads responsive.
    journey
        .mock()
        .repeat_slow_text(
            "A deliberately slow model reply.",
            Duration::from_millis(250),
        )
        .await;
    let slow_session = journey.session("genet").await?;
    let requests_before = journey.mock().request_count().await;
    journey.send(&slow_session, "Wait for the model.").await?;
    wait_until(Duration::from_secs(30), || async {
        journey.mock().request_count().await > requests_before
    })
    .await
    .context("slow model request never reached the mock")?;
    let model_started = Instant::now();
    let mut slow_model_reads = Vec::new();
    for _ in 0..20 {
        let started = Instant::now();
        control
            .call(Request::WorkspaceList)
            .await
            .context("unrelated read during slow model")?;
        slow_model_reads.push(started.elapsed());
    }
    let slow_events = journey.client.drain_turn().await?;
    let slow_model_turn = model_started.elapsed();
    assert!(slow_events.completed(), "slow model turn did not complete");
    journey.mock().clear_repeated().await;

    // Regression control: git.status defers its Process::Run batch outside the
    // resident guest turn. A marker tells us real OS work began before the
    // unrelated request is issued.
    let git_workspace = journey.additional_workspace("git-canary").await?;
    let real_git = command_path("git")?;
    let status = std::process::Command::new(&real_git)
        .args(["init", "-q"])
        .current_dir(&git_workspace.root)
        .status()?;
    if !status.success() {
        bail!("could not initialize git canary workspace");
    }
    std::fs::write(
        Path::new(&git_workspace.root).join("tracked.txt"),
        "content\n",
    )?;
    let wrapper_dir = Path::new(&git_workspace.root).join("slow-bin");
    std::fs::create_dir_all(&wrapper_dir)?;
    let marker = wrapper_dir.join("git-started");
    let wrapper = wrapper_dir.join("git");
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\n: > {}\nsleep 0.9\nexec {} \"$@\"\n",
            shell_quote(&marker),
            shell_quote(&real_git)
        ),
    )?;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755))?;
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let mut slow_path = vec![wrapper_dir.clone()];
    slow_path.extend(std::env::split_paths(&original_path));
    let guarded_path = EnvGuard::set("PATH", std::env::join_paths(slow_path)?);
    let git_client = Arc::clone(&git_control);
    let git_workspace_id = git_workspace.id.clone();
    let git_started = Instant::now();
    let git_task = tokio::spawn(async move {
        git_client
            .call(Request::GitStatus {
                workspace_id: git_workspace_id,
            })
            .await
    });
    wait_until(Duration::from_secs(10), || {
        let marker = marker.clone();
        async move { marker.exists() }
    })
    .await
    .context("git wrapper marker was never written")?;
    // Use different authenticated carriers. Reusing the Git carrier would
    // only measure its intentional message ordering. Probe both a resident
    // in-memory read and a request that needs its own real file capability.
    let (unrelated_read, unrelated_capability) = tokio::join!(
        async {
            let started = Instant::now();
            let result = control.call(Request::WorkspaceList).await;
            (started.elapsed(), result)
        },
        async {
            let started = Instant::now();
            let result = capability_control
                .call(Request::FileTree {
                    workspace_id: git_workspace.id.clone(),
                    path: None,
                    depth: Some(1),
                })
                .await;
            (started.elapsed(), result)
        }
    );
    unrelated_read
        .1
        .context("unrelated resident read during slow git")?;
    unrelated_capability
        .1
        .context("unrelated file capability during slow git")?;
    let git_reply = git_task.await.context("git canary task panicked")??;
    let slow_git_request = git_started.elapsed();
    if !matches!(git_reply, Reply::GitStatus(_)) {
        bail!("git canary returned {git_reply:?}");
    }
    drop(guarded_path);

    // Downstream control: the same preview flood is first drained normally,
    // then sent to a browser whose authenticated socket has stopped reading.
    let preview_path = Path::new(&git_workspace.root).join("large.md");
    std::fs::write(&preview_path, vec![b'x'; BACKPRESSURE_PREVIEW_BYTES])?;
    let asset = format!("{}/large.md", git_workspace.folders[0].root_handle);
    let flood = Arc::new(Client::connect_loopback(journey.daemon()).await?);
    flood.hello("flowing-browser").await?;
    let flood_count = 128;
    let flood_workers = 128;
    let flowing_tasks = preview_flood(
        Arc::clone(&flood),
        git_workspace.id.clone(),
        asset.clone(),
        flood_count,
        flood_workers,
    );
    tokio::time::sleep(Duration::from_millis(100)).await;
    let flowing_started = Instant::now();
    control
        .call(Request::WorkspaceList)
        .await
        .context("unrelated read during flowing preview flood")?;
    let flowing_unrelated = flowing_started.elapsed();
    await_flood(flowing_tasks)
        .await
        .context("flowing browser preview flood")?;

    let paused = Arc::new(Client::connect_loopback(journey.daemon()).await?);
    paused.hello("paused-browser").await?;
    paused.pause_inbound();
    tokio::time::sleep(Duration::from_millis(50)).await;
    let paused_tasks = preview_flood(
        Arc::clone(&paused),
        git_workspace.id.clone(),
        asset,
        flood_count,
        flood_workers,
    );
    // Give every initial stream window time to reach the socket while staying
    // below the native writer's ten-second send timeout.
    tokio::time::sleep(Duration::from_secs(5)).await;
    let paused_started = Instant::now();
    let paused_result = tokio::time::timeout(
        Duration::from_millis(1_500),
        control.call(Request::WorkspaceList),
    )
    .await;
    let paused_unrelated = paused_started.elapsed();
    let paused_timed_out = paused_result.is_err();
    if let Ok(result) = paused_result {
        result.context("unrelated read during paused preview flood")?;
    }
    paused.resume_inbound();
    await_flood(paused_tasks)
        .await
        .context("paused browser preview flood recovery")?;

    let report = CanaryReport {
        logical_cpus: std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1),
        slow_model_turn_ms: millis(slow_model_turn),
        slow_model_unrelated: LatencySummary::durations(slow_model_reads, 0),
        slow_git_request_ms: millis(slow_git_request),
        slow_git_unrelated_read_ms: millis(unrelated_read.0),
        slow_git_unrelated_capability_ms: millis(unrelated_capability.0),
        flowing_browser_unrelated_ms: millis(flowing_unrelated),
        paused_browser_unrelated_ms: millis(paused_unrelated),
        paused_browser_amplification: paused_unrelated.as_secs_f64()
            / flowing_unrelated.as_secs_f64().max(f64::EPSILON),
        paused_browser_timed_out: paused_timed_out,
        preview_flood_requests: flood_count,
        preview_flood_workers: flood_workers,
    };
    emit_report("canaries", "causal", &report)?;

    assert!(
        report.slow_model_unrelated.p95_ms < report.slow_model_turn_ms / 2.0,
        "a slow model unexpectedly blocked resident daemon reads: {report:?}"
    );
    assert!(
        report.slow_git_unrelated_read_ms < 500.0,
        "a deferred git capability delayed an unrelated resident read: {report:?}"
    );
    assert!(
        report.slow_git_unrelated_capability_ms < 500.0,
        "a deferred git capability delayed an unrelated OS capability: {report:?}"
    );
    // This is intentionally observational rather than asserting that a paused
    // browser must stall everyone. Per-stream credit plus TCP buffering can
    // keep the native 64-slot queue draining. The report tells an architecture
    // run whether and where that protection stopped being sufficient.

    let paused =
        Arc::try_unwrap(paused).map_err(|_| anyhow::anyhow!("paused client still has an owner"))?;
    paused.close().await;
    let flood =
        Arc::try_unwrap(flood).map_err(|_| anyhow::anyhow!("flood client still has an owner"))?;
    flood.close().await;
    let control = Arc::try_unwrap(control)
        .map_err(|_| anyhow::anyhow!("control client still has an owner"))?;
    control.close().await;
    let git_control = Arc::try_unwrap(git_control)
        .map_err(|_| anyhow::anyhow!("git control client still has an owner"))?;
    git_control.close().await;
    let capability_control = Arc::try_unwrap(capability_control)
        .map_err(|_| anyhow::anyhow!("capability control client still has an owner"))?;
    capability_control.close().await;
    journey.finish().await;
    Ok(())
}

fn preview_flood(
    client: Arc<Client>,
    workspace_id: String,
    path: String,
    count: usize,
    workers: usize,
) -> Vec<tokio::task::JoinHandle<Result<()>>> {
    // Keep a bounded number of logical streams active. This applies sustained
    // downstream pressure without turning the client's own 256-stream limit
    // into the thing being measured.
    let workers = count.min(workers.max(1));
    (0..workers)
        .map(|worker| {
            let client = Arc::clone(&client);
            let workspace_id = workspace_id.clone();
            let path = path.clone();
            tokio::spawn(async move {
                for _ in (worker..count).step_by(workers) {
                    let (head, body) = client.preview(&workspace_id, &path).await?;
                    if head.status != 200 || body.len() != BACKPRESSURE_PREVIEW_BYTES {
                        bail!(
                            "preview flood returned status {} and {} bytes",
                            head.status,
                            body.len()
                        );
                    }
                }
                Ok(())
            })
        })
        .collect()
}

async fn await_flood(tasks: Vec<tokio::task::JoinHandle<Result<()>>>) -> Result<()> {
    tokio::time::timeout(Duration::from_secs(90), async {
        for result in join_all(tasks).await {
            result.context("preview flood task panicked")??;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("preview flood did not recover")?
}

async fn wait_until<F, Fut>(within: Duration, mut predicate: F) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = bool>,
{
    let deadline = Instant::now() + within;
    while Instant::now() < deadline {
        if predicate().await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    bail!("condition did not become true within {within:?}")
}

#[cfg(unix)]
fn command_path(command: &str) -> Result<PathBuf> {
    let output = std::process::Command::new("sh")
        .args(["-c", &format!("command -v {command}")])
        .output()?;
    if !output.status.success() {
        bail!("could not find {command} on PATH");
    }
    Ok(PathBuf::from(
        String::from_utf8(output.stdout)?.trim().to_string(),
    ))
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

struct EnvGuard {
    key: &'static str,
    previous: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let previous = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, previous }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

fn emit_report(kind: &str, profile: &str, report: &impl Serialize) -> Result<()> {
    let encoded = serde_json::to_string_pretty(report)?;
    println!("GENEHUB_CONCURRENCY_{kind}:\n{encoded}");
    if let Some(path) = std::env::var_os("GENET_CONCURRENCY_REPORT") {
        let path = PathBuf::from(path);
        let path = if path.extension().is_some() {
            path
        } else {
            path.join(format!("{kind}-{profile}.json"))
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, format!("{encoded}\n"))?;
    }
    Ok(())
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1_000.0
}
