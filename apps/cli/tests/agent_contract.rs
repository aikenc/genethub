use std::process::Command;

use futures_util::{SinkExt, StreamExt};
use genehub_proto::PeerWelcome;
use tokio_tungstenite::tungstenite::Message;

fn genet() -> Command {
    Command::new(env!("CARGO_BIN_EXE_genet-dev"))
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

fn envelope(arguments: &[&str], expected_exit: i32) -> serde_json::Value {
    let output = genet().args(arguments).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(expected_exit),
        "genet {}",
        arguments.join(" ")
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn every_command_states_whether_it_can_run_on_another_machine() {
    let schema = envelope(&["schema"], 0);
    let commands = schema["data"]["commands"].as_array().unwrap();
    assert!(!commands.is_empty());
    for command in commands {
        let name = command["name"].as_str().unwrap();
        let routable = command["routable"]
            .as_bool()
            .unwrap_or_else(|| panic!("{name} has no routable flag"));
        // The selector is advertised exactly where it is accepted, so the map
        // an agent reads once never points at a path that always fails.
        let advertises_machine = command["inputSchema"]["properties"]
            .get("machine")
            .is_some();
        assert_eq!(routable, advertises_machine, "{name}");
    }
    assert_eq!(schema["data"]["commands"][0]["mutation"], false);
}

#[test]
fn capabilities_describe_remote_and_isolation_without_changing_frozen_types() {
    let capabilities = envelope(&["capabilities"], 0);
    let data = &capabilities["data"];

    // Still a boolean, because scripts already branch on it; the detail that
    // does not fit in a boolean is an added sibling.
    assert_eq!(data["remoteExec"], true);
    assert_eq!(data["remote"]["hostedHub"], true);
    let transports = data["remote"]["transports"].as_array().unwrap();
    assert!(transports.iter().any(|kind| kind == "rendezvous"));
    assert_eq!(data["remote"]["selector"]["flag"], "--machine");
    // Nothing is ever aimed elsewhere unless it was named: an agent that omits
    // the flag has to be able to rely on running here.
    assert_eq!(data["remote"]["selector"]["implicitDefault"], false);

    // `genet shell` runs an argv list, so arbitrary commands are offered and no
    // command line is ever parsed here.
    assert_eq!(data["isolation"]["arbitraryCommands"], true);
    assert_eq!(data["isolation"]["commandLineParsing"], false);
    // What can actually be enforced is a property of the machine that would run
    // the process, not of this binary. A null engine here must be read as "ask
    // over there", never as "nothing is enforced".
    assert!(data["isolation"]["engine"].is_null());
    assert_eq!(
        data["isolation"]["reportedBy"], "context.daemon.isolation",
        "a null engine has to say where the real answer lives"
    );
    assert_eq!(data["workingDirectory"]["inferred"], false);
}

#[test]
fn a_machine_selector_is_refused_by_name_rather_than_ignored() {
    // Local-only: stopping this machine's daemon has no remote meaning.
    let local_only = envelope(&["daemon", "stop", "--machine", "m_other"], 2);
    assert_eq!(local_only["error"]["code"], "commandNotRoutable");
    assert_eq!(local_only["error"]["details"]["command"], "daemon.stop");

    // Static: answered by this binary, so it never reaches any daemon.
    let statically_answered = envelope(&["schema", "--machine", "m_other"], 2);
    assert_eq!(statically_answered["error"]["code"], "commandNotRoutable");

    // Routable, and aimed at a machine this installation never paired with.
    // The one outcome this must never be is a silent local run.
    let routable = envelope(&["session", "list", "--machine=m_other"], 4);
    assert_eq!(routable["error"]["code"], "machineNotPaired");
    assert_eq!(routable["error"]["details"]["machineId"], "m_other");
    assert_eq!(routable["error"]["retryable"], false);
}

#[test]
fn the_working_directory_is_refused_where_it_would_be_ignored() {
    let error = envelope(&["workspace", "list", "--cwd", "/srv/app"], 2);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn data_plane_version_rejection_is_typed_and_not_marked_retryable() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut socket = tokio_tungstenite::accept_async(socket).await.unwrap();
        let Message::Binary(_) = socket.next().await.unwrap().unwrap() else {
            panic!("PeerHello must be a binary frame");
        };
        let response = PeerWelcome {
            version: 999,
            server_nonce: "11".repeat(16),
            proof: "22".repeat(32),
        };
        socket
            .send(Message::Binary(serde_json::to_vec(&response).unwrap()))
            .await
            .unwrap();
    });

    let dir = tempfile::tempdir().unwrap();
    std::fs::write(
        dir.path().join("endpoint.json"),
        serde_json::json!({
            "port": port,
            "token": "test-token",
            "machineId": "machine-test",
            "fingerprint": "fingerprint-test",
            "pid": std::process::id(),
        })
        .to_string(),
    )
    .unwrap();
    let root = dir.path().to_path_buf();
    let output = tokio::task::spawn_blocking(move || {
        genet()
            .arg("context")
            .env("GENEHUB_DEV_DATA_DIR", &root)
            .env("GENEHUB_DEV_WORKSPACE_DIR", &root)
            .output()
            .unwrap()
    })
    .await
    .unwrap();
    server.await.unwrap();

    assert_eq!(output.status.code(), Some(3));
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "protocolIncompatible");
    assert_eq!(value["error"]["retryable"], false);
}
