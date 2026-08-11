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
            return Relay {
                process,
                origin: format!("http://127.0.0.1:{port}"),
            };
        }
    }
    panic!("the relay never said where it was listening");
}

struct Cli {
    home: tempfile::TempDir,
}

impl Cli {
    fn new() -> Self {
        Cli {
            home: tempfile::tempdir().expect("a data directory for the CLI"),
        }
    }

    /// One `genet` run, as an agent would get it: the JSON envelope and the
    /// exit code, together, because the pair is the contract.
    fn run(&self, arguments: &[&str]) -> (Value, i32) {
        let output = Command::new(env!("CARGO_BIN_EXE_genet-dev"))
            .args(arguments)
            .env("GENEHUB_DEV_DATA_DIR", self.home.path())
            .env("GENEHUB_DEV_WORKSPACE_DIR", self.home.path())
            .output()
            .expect("the CLI could not be run");
        let stdout = String::from_utf8(output.stdout).expect("the CLI printed invalid UTF-8");
        let last = stdout
            .lines()
            .filter(|line| line.trim_start().starts_with('{'))
            .next_back()
            .unwrap_or_else(|| panic!("no envelope in: {stdout}"));
        (
            serde_json::from_str(last).expect("the CLI printed something that is not JSON"),
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
    daemon
        .state
        .workspaces
        .open(&project, None)
        .await
        .expect("opening the workspace on the machine");
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
