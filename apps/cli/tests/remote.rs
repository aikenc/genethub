//! The CLI reaching a machine through a relay it does not trust.
//!
//! Everything here is real: the relay is the shipped Node process, the machine
//! is a daemon with its own device list, and the caller is the built binary run
//! as a subprocess. Nothing about remote execution can be established by unit
//! tests — each half can be correct while the pair fails to meet — and the
//! failures that matter most (a machine that is merely asleep, a credential
//! that was withdrawn, an invitation that was narrowed) only exist end to end.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use genehub_testing::harness::agent_command_override;
use genehub_testing::mock_llm::{MockLlm, Turn};
use genet_daemon::authz::{Capability, GrantSet};
use genet_daemon::config::{Config, Paths, ProviderConfig};
use genet_daemon::Daemon;
use serde_json::Value;

const JOIN_TOKEN: &str = "cli-e2e-join-token-that-is-long-enough";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("the crate lives two levels below the repository root")
        .to_path_buf()
}

/// The relay is a build output. Skipping beats failing on a tree where nobody
/// ran the Node build, and saying so beats passing silently.
fn relay_bundle() -> Option<PathBuf> {
    let bundle = repo().join("apps/relay/dist/main.js");
    if bundle.exists() {
        return Some(bundle);
    }
    eprintln!(
        "skipping: {} is missing; run `npm --prefix apps/relay run build`",
        bundle.display()
    );
    None
}

struct Relay {
    process: Child,
    origin: String,
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

fn start_relay(bundle: &Path) -> Relay {
    let mut process = Command::new("node")
        .arg(bundle)
        .env("RELAY_MODE", "rendezvous")
        .env("RELAY_HOST", "127.0.0.1")
        .env("RELAY_PORT", "0")
        .env("RELAY_JOIN_TOKEN", JOIN_TOKEN)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the relay could not be started");

    let stdout = process.stdout.take().expect("relay stdout");
    // Owned before it is read from, so that giving up below still reaps it.
    let mut relay = Relay {
        process,
        origin: String::new(),
    };
    let mut lines = BufReader::new(stdout).lines();
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        let Some(Ok(line)) = lines.next() else { break };
        if let Some(port) = line
            .split("http://127.0.0.1:")
            .nth(1)
            .and_then(|tail| tail.split(|c: char| !c.is_ascii_digit()).next())
            .filter(|port| !port.is_empty())
        {
            relay.origin = format!("http://127.0.0.1:{port}");
            return relay;
        }
    }
    panic!("the relay never said where it was listening");
}

/// A `genet` installation: one data directory, and the binary run against it.
enum Cli {
    /// Its own directory, holding nothing but what pairing put there. This is
    /// the jump box or CI runner the feature exists for.
    Elsewhere(tempfile::TempDir),
    /// The machine's own directory, so the same binary reaches the daemon over
    /// loopback. Only used to compare the two answers.
    OnTheMachine(PathBuf),
}

impl Cli {
    fn new() -> Self {
        Cli::Elsewhere(tempfile::tempdir().expect("a data directory for the CLI"))
    }

    fn on(data: &Path) -> Self {
        Cli::OnTheMachine(data.to_path_buf())
    }

    fn home(&self) -> &Path {
        match self {
            Cli::Elsewhere(dir) => dir.path(),
            Cli::OnTheMachine(path) => path,
        }
    }

    /// One `genet` run, as an agent would get it: the JSON envelope and the
    /// exit code, together, because the pair is the contract.
    fn run(&self, arguments: &[&str]) -> (Value, i32) {
        let (raw, code) = self.raw(arguments);
        let last = raw
            .lines()
            .rfind(|line| line.trim_start().starts_with('{'))
            .unwrap_or_else(|| panic!("no envelope in: {raw}"));
        (
            serde_json::from_str(last).expect("the CLI printed something that is not JSON"),
            code,
        )
    }

    /// Everything the command printed, unparsed. A streaming command emits one
    /// envelope per line and the order is part of the contract.
    fn raw(&self, arguments: &[&str]) -> (String, i32) {
        let output = Command::new(env!("CARGO_BIN_EXE_genet-dev"))
            .args(arguments)
            .env("GENEHUB_DEV_DATA_DIR", self.home())
            .env("GENEHUB_DEV_WORKSPACE_DIR", self.home())
            .output()
            .expect("the CLI could not be run");
        (
            String::from_utf8(output.stdout).expect("the CLI printed invalid UTF-8"),
            output.status.code().unwrap_or(-1),
        )
    }
}

/// The one provider the far machine has, pointed at the mock.
fn write_provider_config(data: &Path, model_base_url: &str) {
    let mut config = Config::default();
    config.agents.providers.insert(
        "deepseek".to_string(),
        ProviderConfig {
            api_key: Some("sk-mock".to_string()),
            base_url: Some(model_base_url.to_string()),
            ..Default::default()
        },
    );
    config
        .save(&data.join("config.json"))
        .expect("writing the machine's config");
}

/// Puts the machine at a rendezvous and waits until it is actually there.
async fn attach(daemon: &Daemon, relay_origin: &str) -> String {
    let rendezvous = daemon
        .state
        .remote
        .get()
        .expect("the remote is attached")
        .set(relay_origin, Some(JOIN_TOKEN.to_string()))
        .await
        .expect("attaching to the relay")
        .rendezvous_url
        .expect("the relay gave the machine no address");
    wait_until_online(daemon).await;
    rendezvous
}

async fn wait_until_online(daemon: &Daemon) {
    let remote = daemon.state.remote.get().expect("the remote is attached");
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if remote.status().await.online {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the machine never arrived at its rendezvous");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_across_a_relay_answers_exactly_as_the_local_one_does() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let data = tempfile::tempdir().expect("a data directory for the machine");
    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    let rendezvous = attach(&daemon, &relay.origin).await;

    // Pairing, from a CLI installation that has never heard of this machine.
    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let cli = Cli::new();
    let (paired, code) = cli.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "the test's CLI",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();
    assert_eq!(machine_id, daemon.state.machine.machine_id);

    // The credential is this installation's own, so the call needs no daemon
    // running on this side.
    let (context, code) = cli.run(&["context", "--machine", &machine_id]);
    assert_eq!(code, 0, "{context}");
    assert_eq!(context["data"]["source"], "remoteDaemon");
    assert_eq!(context["data"]["target"]["machineId"], machine_id);
    assert_eq!(
        context["data"]["target"]["credential"],
        "pairedDeviceSecret"
    );

    let (sessions, code) = cli.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(code, 0, "{sessions}");
    assert_eq!(sessions["type"], "session.list");

    // A narrowed invitation is narrow on the wire, not only in the record: this
    // device may look, and may not decide who else gets in.
    let narrow = daemon
        .state
        .devices
        .invite_with(GrantSet::of([Capability::Read]));
    let onlooker = Cli::new();
    let (paired, code) = onlooker.run(&[
        "machine",
        "pair",
        &narrow.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI that may only look",
    ]);
    assert_eq!(code, 0, "{paired}");
    let (listed, code) = onlooker.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(code, 0, "{listed}");
    let (refused, code) = onlooker.run(&["device", "invite", "--machine", &machine_id]);
    assert_ne!(code, 0, "{refused}");
    assert_eq!(refused["type"], "error");
    assert_eq!(refused["error"]["retryable"], false);
    assert!(
        refused["error"]["message"]
            .as_str()
            .is_some_and(|message| message.contains("devices")),
        "a refusal should name the grant that was missing: {refused}"
    );

    // A machine that is not at its rendezvous is a wait, not a verdict. The
    // ticket was not spent finding out, and an agent told otherwise would
    // re-pair a laptop whose lid was closed.
    daemon
        .state
        .remote
        .get()
        .expect("the remote is attached")
        .clear()
        .await
        .expect("detaching from the relay");
    let (offline, code) = cli.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(offline["error"]["code"], "machineOffline", "{offline}");
    assert_eq!(offline["error"]["retryable"], true);
    assert_eq!(code, 3, "{offline}");

    daemon.shutdown().await;
}

/// The claim the whole feature exists to make: a prompt typed here runs there,
/// in a directory named here, and comes back as a finished turn.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_prompt_typed_here_is_answered_by_an_agent_running_there() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let model = MockLlm::start().await.expect("the mock model");
    let data = tempfile::tempdir().expect("a data directory for the machine");
    let project = data.path().join("project");
    std::fs::create_dir_all(&project).expect("the project directory");
    write_provider_config(data.path(), &model.base_url);
    let (variable, agent) = agent_command_override().expect("locating the agent binary");
    std::env::set_var(variable, agent);

    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    let rendezvous = attach(&daemon, &relay.origin).await;

    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let cli = Cli::new();
    let (paired, code) = cli.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI with something to ask",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();

    model.reply(Turn::text("编译得过。")).await;
    // The directory is the one on that machine, and it is named rather than
    // inferred — this process's own working directory means nothing there.
    let (result, code) = cli.run(&[
        "--machine",
        &machine_id,
        "--cwd",
        &project.to_string_lossy(),
        "genet",
        "这个仓库编译得过吗",
        "--model",
        genehub_testing::harness::REAL_MODEL,
        // The directory is not registered there yet, and registering it is
        // something the far machine can do for itself.
        "--open-workspace",
        "--timeout",
        "60",
    ]);
    assert_eq!(code, 0, "{result}");
    assert_eq!(result["type"], "session.result");
    assert_eq!(result["data"]["status"], "completed");
    assert!(
        model.request_count().await >= 1,
        "the model on the far machine was never asked anything"
    );

    daemon.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_device_that_was_revoked_is_told_to_pair_again_rather_than_to_wait() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let data = tempfile::tempdir().expect("a data directory for the machine");
    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    let rendezvous = attach(&daemon, &relay.origin).await;

    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let cli = Cli::new();
    let (paired, code) = cli.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI about to lose its welcome",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();

    let device_id = daemon
        .state
        .devices
        .list()
        .into_iter()
        .find(|device| device.name.contains("lose its welcome"))
        .expect("the machine did not record the device it just admitted")
        .id;
    daemon
        .state
        .devices
        .revoke(&device_id)
        .expect("revoking the device");

    let (refused, code) = cli.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(refused["error"]["code"], "credentialRevoked", "{refused}");
    // Waiting will never help, and the exit code has to say so as clearly as
    // the message does: a failure, not the unreachable code that invites a
    // retry loop.
    assert_eq!(refused["error"]["retryable"], false);
    assert_eq!(code, 4, "{refused}");

    daemon.shutdown().await;
}

/// §1.1 的原话：远程执行「语义等价于在目标机本地执行」。
///
/// The claim is not that both answers are plausible. It is that they are the
/// same bytes, so an agent can be written once and pointed anywhere. Anything
/// that leaks the route into the payload — a path rewritten, a field only the
/// loopback path fills in — breaks it, and would otherwise be found by whoever
/// diffed two transcripts at three in the morning.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_same_command_returns_the_same_bytes_from_here_and_from_there() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let data = tempfile::tempdir().expect("a data directory for the machine");
    let project = data.path().join("project");
    std::fs::create_dir_all(&project).expect("the project directory");
    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    daemon
        .state
        .workspaces
        .open(&project, None)
        .await
        .expect("opening a workspace so the answer is not empty");
    let rendezvous = attach(&daemon, &relay.origin).await;

    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let elsewhere = Cli::new();
    let (paired, code) = elsewhere.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI that will compare notes",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();

    // The same binary, one installation on the machine and one anywhere else.
    let here = Cli::on(data.path());
    for command in [
        vec!["workspace", "list"],
        vec!["session", "list"],
        vec!["agent", "list"],
    ] {
        let (local, local_code) = here.raw(&command);
        let mut routed = command.clone();
        routed.push("--machine");
        routed.push(&machine_id);
        let (remote, remote_code) = elsewhere.raw(&routed);
        assert_eq!(
            local,
            remote,
            "`genet {}` answered differently through the relay",
            command.join(" ")
        );
        assert_eq!(local_code, remote_code);
    }

    // `context` is the one command that must differ, and differ honestly: it
    // exists to say which machine answered.
    let (local, _) = here.run(&["context"]);
    let (remote, _) = elsewhere.run(&["context", "--machine", &machine_id]);
    assert_eq!(local["data"]["source"], "localDaemon");
    assert_eq!(remote["data"]["source"], "remoteDaemon");
    assert_eq!(
        local["data"]["daemon"]["machineId"], remote["data"]["daemon"]["machineId"],
        "the same machine described itself as two different ones"
    );

    daemon.shutdown().await;
}

/// A session outlives the process that started it, and can be picked up again
/// from the seq the caller last saw.
///
/// This is the promise `--no-wait` makes, and it is the one an orchestrator
/// leans on hardest: it fires a long task, goes away, and comes back. Proving
/// it needs the CLI process to actually exit between the two halves, which is
/// why it cannot be shown from inside one connection.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_backgrounded_conversation_keeps_going_and_can_be_picked_up_again() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let model = MockLlm::start().await.expect("the mock model");
    let data = tempfile::tempdir().expect("a data directory for the machine");
    let project = data.path().join("project");
    std::fs::create_dir_all(&project).expect("the project directory");
    write_provider_config(data.path(), &model.base_url);
    let (variable, agent) = agent_command_override().expect("locating the agent binary");
    std::env::set_var(variable, agent);

    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    let rendezvous = attach(&daemon, &relay.origin).await;
    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let cli = Cli::new();
    let (paired, code) = cli.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI that will walk away",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();

    // Turn one, watched. This is the caller's baseline: the last seq it saw.
    model.reply(Turn::text("第一轮的回答")).await;
    let (watched, code) = cli.raw(&[
        "--machine",
        &machine_id,
        "--cwd",
        &project.to_string_lossy(),
        "genet",
        "先说第一句",
        "--model",
        genehub_testing::harness::REAL_MODEL,
        "--open-workspace",
    ]);
    assert_eq!(code, 0, "{watched}");
    let session_id = envelopes(&watched)[0]["data"]["sessionId"]
        .as_str()
        .expect("no session id to come back to")
        .to_string();
    let seen = settled(&cli, &machine_id, &session_id).await;

    // Turn two runs with nobody watching, and the process that started it is
    // gone before it finishes.
    model.reply(Turn::text("第二轮的回答")).await;
    let (backgrounded, code) = cli.run(&[
        "session",
        "send",
        &session_id,
        "这一句我不等了",
        "--machine",
        &machine_id,
        "--no-wait",
    ]);
    assert_eq!(code, 0, "{backgrounded}");
    // Not waiting is not the same as not answering: the caller still gets a
    // terminal envelope, and it says the turn was left running on purpose.
    assert_eq!(backgrounded["type"], "session.result", "{backgrounded}");
    assert_eq!(backgrounded["data"]["status"], "running", "{backgrounded}");
    assert_eq!(backgrounded["data"]["waited"], false, "{backgrounded}");
    let after_two = settled(&cli, &machine_id, &session_id).await;
    assert!(after_two > seen, "the unwatched turn produced no events");
    assert_eq!(model.request_count().await, 2);

    // Coming back from the seq it holds, the caller is given exactly what it
    // missed — not a reset, and not silence.
    model.reply(Turn::text("第三轮的回答")).await;
    let (resumed, code) = cli.raw(&[
        "session",
        "send",
        &session_id,
        "接着上面那个思路",
        "--machine",
        &machine_id,
        "--since-seq",
        &seen.to_string(),
    ]);
    assert_eq!(code, 0, "{resumed}");
    let stream = envelopes(&resumed);
    assert!(
        !stream.iter().any(|line| line["type"] == "session.desync"),
        "a seq still inside the window was treated as a gap: {resumed}"
    );
    assert!(
        resumed.contains("第二轮的回答"),
        "the replay dropped the turn that ran while nobody watched: {resumed}"
    );
    assert!(
        stream
            .iter()
            .filter(|line| line["type"] == "session.event")
            .all(|line| line["data"]["seq"].as_u64().unwrap_or(0) > seen),
        "the replay repeated events the caller already had: {resumed}"
    );
    let last = stream.last().expect("no envelope at all");
    assert_eq!(last["type"], "session.result");
    assert_eq!(last["data"]["status"], "completed", "{last}");
    assert_eq!(model.request_count().await, 3);

    // Asking from zero is the other case, and it has to be told apart from the
    // one above: nothing is replayed, and the caller is told so rather than
    // being left to conclude the session was empty.
    model.reply(Turn::text("第四轮的回答")).await;
    let (from_zero, code) = cli.raw(&[
        "session",
        "send",
        &session_id,
        "从头开始接",
        "--machine",
        &machine_id,
        "--since-seq",
        "0",
    ]);
    assert_eq!(code, 0, "{from_zero}");
    let stream = envelopes(&from_zero);
    assert_eq!(stream[0]["type"], "session.attached");
    assert_eq!(stream[1]["type"], "session.desync", "{from_zero}");
    assert!(!from_zero.contains("第二轮的回答"), "{from_zero}");

    daemon.shutdown().await;
}

/// Every JSON line a streaming command printed, in order.
fn envelopes(printed: &str) -> Vec<Value> {
    printed
        .lines()
        .filter(|line| line.trim_start().starts_with('{'))
        .map(|line| serde_json::from_str(line).expect("the CLI printed something that is not JSON"))
        .collect()
}

/// Waits for the far machine to finish whatever it is doing, and reports the
/// seq it stopped at.
async fn settled(cli: &Cli, machine_id: &str, session_id: &str) -> u64 {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let (snapshot, code) = cli.run(&["session", "get", session_id, "--machine", machine_id]);
        assert_eq!(code, 0, "{snapshot}");
        let session = &snapshot["data"]["session"];
        if session["summary"]["status"] == "idle" {
            return session["seq"].as_u64().expect("a session without a seq");
        }
        assert!(
            Instant::now() < deadline,
            "the turn never settled: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// The machine that answers has to be the machine that was paired with.
///
/// The proof already settles that whoever answered knows the device secret, so
/// this catches the honest case rather than the adversarial one: a daemon
/// reinstalled behind the same rendezvous holds a new identity key, and
/// carrying on as if nothing happened would silently redefine what `--machine
/// m_x` means.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_machine_that_answers_with_a_different_identity_is_refused() {
    let Some(bundle) = relay_bundle() else { return };
    let relay = start_relay(&bundle);

    let data = tempfile::tempdir().expect("a data directory for the machine");
    let daemon = Daemon::start(Paths::new(data.path()))
        .await
        .expect("the machine could not be started");
    let rendezvous = attach(&daemon, &relay.origin).await;

    let invite = daemon.state.devices.invite_with(GrantSet::full());
    let cli = Cli::new();
    let (paired, code) = cli.run(&[
        "machine",
        "pair",
        &invite.code,
        "--endpoint",
        &rendezvous,
        "--name",
        "a CLI holding a stale fingerprint",
    ]);
    assert_eq!(code, 0, "{paired}");
    let machine_id = paired["data"]["machine"]["machineId"]
        .as_str()
        .expect("the pairing did not name the machine")
        .to_string();

    let store = cli.home().join("machines.json");
    let mut remembered: Value = serde_json::from_str(
        &std::fs::read_to_string(&store).expect("the pairing wrote no machine store"),
    )
    .expect("the machine store is not JSON");
    remembered["machines"][0]["fingerprint"] = Value::String("AA-BB-CC-DD".into());
    std::fs::write(&store, remembered.to_string()).expect("rewriting the machine store");

    let (refused, code) = cli.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(
        refused["error"]["code"], "protocolIncompatible",
        "{refused}"
    );
    assert_eq!(refused["error"]["retryable"], false);
    assert_eq!(code, 3, "{refused}");

    // Forgetting is the other half of the story, and it has to bite
    // immediately: a credential dropped here must stop working here.
    let (forgotten, code) = cli.run(&["machine", "forget", &machine_id]);
    assert_eq!(code, 0, "{forgotten}");
    assert_eq!(forgotten["data"]["forgotten"], true);
    let (gone, code) = cli.run(&["session", "list", "--machine", &machine_id]);
    assert_eq!(gone["error"]["code"], "machineNotPaired", "{gone}");
    assert_eq!(code, 4, "{gone}");

    daemon.shutdown().await;
}
