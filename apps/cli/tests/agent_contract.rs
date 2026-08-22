use std::process::Command;

use genet_daemon::config::Paths;
use genet_daemon::Daemon;

fn genet() -> Command {
    Command::new(env!("CARGO_BIN_EXE_genet-dev"))
}

struct Live {
    _daemon: Daemon,
    dir: tempfile::TempDir,
}

async fn live() -> Live {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(Paths::new(dir.path())).await.unwrap();
    Live {
        _daemon: daemon,
        dir,
    }
}

fn genet_on(live: &Live) -> Command {
    let mut command = genet();
    command
        .env("GENEHUB_DEV_DATA_DIR", live.dir.path())
        .env("GENEHUB_DEV_WORKSPACE_DIR", live.dir.path());
    command
}

fn envelope_from(command: &mut Command, arguments: &[&str], expected_exit: i32) -> serde_json::Value {
    let output = command.args(arguments).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(expected_exit),
        "genet {}\nstderr: {}",
        arguments.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn an_unknown_command_uses_the_same_agent_error_envelope() {
    let output = genet().arg("unknown-command").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["schema"], "genet.cli/v1");
    assert_eq!(value["type"], "error");
    assert_eq!(value["error"]["code"], "invalid_args");
    assert_eq!(value["error"]["retryable"], false);
    assert!(String::from_utf8(output.stderr).unwrap().contains("usage:"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_command_states_whether_it_can_run_on_another_machine() {
    let live = live().await;
    let schema = envelope_from(&mut genet_on(&live), &["schema"], 0);
    let commands = schema["data"]["commands"].as_array().unwrap();
    assert!(!commands.is_empty());
    for command in commands {
        let name = command["name"].as_str().unwrap();
        let routable = command["routable"]
            .as_bool()
            .unwrap_or_else(|| panic!("{name} has no routable flag"));
        let advertises_machine = command["inputSchema"]["properties"]
            .get("machine")
            .is_some();
        assert_eq!(routable, advertises_machine, "{name}");
    }
    assert_eq!(schema["data"]["commands"][0]["mutation"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn capabilities_describe_remote_and_isolation_without_changing_frozen_types() {
    let live = live().await;
    let capabilities = envelope_from(&mut genet_on(&live), &["capabilities"], 0);
    let data = &capabilities["data"];

    assert_eq!(data["remoteExec"], true);
    assert_eq!(data["remote"]["hostedHub"], true);
    let transports = data["remote"]["transports"].as_array().unwrap();
    assert!(transports.iter().any(|kind| kind == "rendezvous"));
    assert_eq!(data["remote"]["selector"]["flag"], "--machine");
    assert_eq!(data["remote"]["selector"]["implicitDefault"], false);

    assert_eq!(data["isolation"]["arbitraryCommands"], true);
    assert_eq!(data["isolation"]["commandLineParsing"], false);
    assert!(data["isolation"]["engine"].is_null());
    assert_eq!(
        data["isolation"]["reportedBy"], "context.daemon.isolation",
        "a null engine has to say where the real answer lives"
    );
    assert_eq!(data["workingDirectory"]["inferred"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_machine_selector_is_refused_by_name_rather_than_ignored() {
    let live = live().await;
    let local_only = envelope_from(
        &mut genet_on(&live),
        &["daemon", "stop", "--machine", "m_other"],
        2,
    );
    assert_eq!(local_only["error"]["code"], "commandNotRoutable");
    assert_eq!(local_only["error"]["details"]["command"], "daemon.stop");

    let statically_answered = envelope_from(
        &mut genet_on(&live),
        &["schema", "--machine", "m_other"],
        2,
    );
    assert_eq!(statically_answered["error"]["code"], "commandNotRoutable");

    let routable = envelope_from(
        &mut genet_on(&live),
        &["session", "list", "--machine=m_other"],
        4,
    );
    assert_eq!(routable["error"]["code"], "machineNotPaired");
    assert_eq!(routable["error"]["details"]["machineId"], "m_other");
    assert_eq!(routable["error"]["retryable"], false);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_working_directory_is_refused_where_it_would_be_ignored() {
    let live = live().await;
    let error = envelope_from(
        &mut genet_on(&live),
        &["workspace", "list", "--cwd", "/srv/app"],
        2,
    );
    assert_eq!(error["error"]["code"], "invalidArgs");
    assert!(error["error"]["message"]
        .as_str()
        .unwrap()
        .contains("--cwd"));
}

#[test]
fn unsigned_self_update_is_explicitly_unsupported() {
    let dir = tempfile::tempdir().unwrap();
    let sentinel = dir.path().join("must-not-run");
    let output = genet()
        .arg("update")
        .env("GENEHUB_TEST_CALLS", &sentinel)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert!(
        !sentinel.exists(),
        "the disabled updater executed a child process"
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "unsupported");
    assert_eq!(value["error"]["retryable"], false);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("SHA256SUMS"));
}

#[test]
fn a_failed_dial_never_prints_the_local_daemon_bearer() {
    let dir = tempfile::tempdir().unwrap();
    let sentinel = "full-local-daemon-secret-must-not-leak";
    std::fs::write(
        dir.path().join("endpoint.json"),
        serde_json::json!({
            "port": 1,
            "token": sentinel,
            "machineId": "machine-test",
            "fingerprint": "fingerprint-test",
            "pid": std::process::id(),
        })
        .to_string(),
    )
    .unwrap();

    let output = genet()
        .arg("context")
        .env("GENEHUB_DEV_DATA_DIR", dir.path())
        .env("GENEHUB_DEV_WORKSPACE_DIR", dir.path())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(!stdout.contains(sentinel));
    assert!(!stderr.contains(sentinel));
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["schema"], "genet.cli/v1");
    assert_eq!(value["error"]["code"], "daemonUnavailable");
    assert_eq!(value["error"]["retryable"], true);
}
