use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use ed25519_dalek::{Signer, SigningKey};
use genet_daemon_platform::{ArtifactEnvelope, SignedArtifact, LOGIC_ABI_VERSION};

const MODULE_ID: &str = "genehub:daemon/logic";
const KEY_ID: &str = "dev-local";

fn genet() -> Command {
    Command::new(env!("CARGO_BIN_EXE_genet-dev"))
}

/// Exercises the public control surface against a real resident daemon. The
/// in-process daemon test proves router behavior; this one also proves endpoint
/// discovery, CLI serialization and process continuity.
#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
fn cli_hot_update_and_rollback_keep_the_same_daemon_process() {
    let source = artifact_path();
    let original = SignedArtifact::from_single_file(&std::fs::read(&source).unwrap()).unwrap();
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let replacement = root.path().join("replacement.wasm");
    std::fs::write(
        &replacement,
        sign("cli-hot-update", original.component.clone())
            .to_single_file()
            .unwrap(),
    )
    .unwrap();

    let daemon = DaemonGuard::start(root.path(), &workspace, &source);
    let before = daemon.command(&["daemon", "status"]);
    assert_success(&before);
    let before: serde_json::Value = serde_json::from_slice(&before.stdout).unwrap();
    let pid = before["pid"].as_u64().expect("daemon pid");
    let port = before["port"].as_u64().expect("daemon port");

    let status = daemon.command(&["daemon", "logic", "status"]);
    assert_success(&status);
    let initial: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    let initial_version = initial["version"].as_str().unwrap().to_string();

    let replacement_text = replacement.to_string_lossy();
    let installed = daemon.command(&["daemon", "logic", "install", replacement_text.as_ref()]);
    assert_success(&installed);
    let installed: serde_json::Value = serde_json::from_slice(&installed.stdout).unwrap();
    assert_eq!(installed["version"], "cli-hot-update");

    assert_same_process(&daemon, pid, port);
    let rolled_back = daemon.command(&["daemon", "logic", "rollback"]);
    assert_success(&rolled_back);
    let rolled_back: serde_json::Value = serde_json::from_slice(&rolled_back.stdout).unwrap();
    assert_eq!(rolled_back["version"], initial_version);
    assert_same_process(&daemon, pid, port);
}

struct DaemonGuard {
    root: PathBuf,
    workspace: PathBuf,
    artifact: PathBuf,
}

impl DaemonGuard {
    fn start(root: &Path, workspace: &Path, artifact: &Path) -> Self {
        let guard = Self {
            root: root.to_path_buf(),
            workspace: workspace.to_path_buf(),
            artifact: artifact.to_path_buf(),
        };
        let output = guard.command(&["daemon", "start"]);
        assert_success(&output);
        guard
    }

    fn command(&self, arguments: &[&str]) -> Output {
        genet()
            .args(arguments)
            .env("GENEHUB_DEV_DATA_DIR", &self.root)
            .env("GENEHUB_DEV_WORKSPACE_DIR", &self.workspace)
            .env("GENET_DAEMON_LOGIC_WASM", &self.artifact)
            .output()
            .unwrap()
    }
}

impl Drop for DaemonGuard {
    fn drop(&mut self) {
        let _ = self.command(&["daemon", "stop"]);
    }
}

fn assert_same_process(daemon: &DaemonGuard, pid: u64, port: u64) {
    let status = daemon.command(&["daemon", "status"]);
    assert_success(&status);
    let value: serde_json::Value = serde_json::from_slice(&status.stdout).unwrap();
    assert_eq!(value["pid"], pid);
    assert_eq!(value["port"], port);
}

fn assert_success(output: &Output) {
    assert!(
        output.status.success(),
        "command failed\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn sign(version: &str, component: Vec<u8>) -> SignedArtifact {
    let key = SigningKey::from_bytes(&[7; 32]);
    let envelope =
        ArtifactEnvelope::unsigned(MODULE_ID, version, LOGIC_ABI_VERSION, KEY_ID, &component)
            .unwrap();
    let signature = key.sign(&envelope.signing_payload().unwrap());
    SignedArtifact::new(envelope.with_signature(&signature), component)
}

fn artifact_path() -> PathBuf {
    std::env::var_os("GENET_DAEMON_LOGIC_WASM")
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .expect("GENET_DAEMON_LOGIC_WASM must name the signed real Rust guest")
}
