//! Native front-door argument and diagnostic behavior. Forwarded business
//! contracts run through the public CLI in testing/specialties/cli/.
use std::process::Command;

fn genet() -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_genet-local"));
    command
        .env_remove("GENEHUB_SESSION_ID")
        .env_remove("GENEHUB_CONTROLLER_TOKEN");
    command
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
fn managed_update_requires_an_explicit_operation() {
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
        "an incomplete update invocation executed a child process"
    );
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(value["error"]["code"], "updateFailed");
    assert_eq!(value["error"]["retryable"], false);
    assert!(value["error"]["message"]
        .as_str()
        .unwrap()
        .contains("update check|live|app|status"));
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
        .env("GENEHUB_LOCAL_DATA_DIR", dir.path())
        .env("GENEHUB_LOCAL_WORKSPACE_DIR", dir.path())
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
