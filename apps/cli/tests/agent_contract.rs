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
