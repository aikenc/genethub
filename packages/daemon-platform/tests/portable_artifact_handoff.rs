mod support;

use std::fs;
use std::path::PathBuf;

use genet_daemon_platform::{
    ArtifactEnvelope, PlatformRuntime, SignedArtifact, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{healthy_component, signed_component, signing_key, verifier, KEY_ID, MODULE_ID};

const COMPONENT_FILE: &str = "daemon-logic.wasm";
const ENVELOPE_FILE: &str = "daemon-logic.envelope.json";
const PORTABLE_VERSION: &str = "portable-linux-ci";

/// CI invokes this only on Linux after rustc has emitted the guest. The output
/// directory is uploaded as one immutable handoff to every native OS runner.
#[test]
#[ignore = "CI fixture producer; requires GENET_PORTABLE_FIXTURE_DIR"]
fn write_linux_portable_fixture() {
    let directory = fixture_directory();
    let component_path = directory.join(COMPONENT_FILE);
    let component = fs::read(&component_path).expect("Linux rustc must create the guest first");
    let artifact = signed_component(&signing_key(7), PORTABLE_VERSION, component);
    let envelope = serde_json::to_vec_pretty(&artifact.envelope).unwrap();
    fs::write(directory.join(ENVELOPE_FILE), envelope).unwrap();
}

/// This test runs on Linux, Windows and macOS against the exact files uploaded
/// by the Linux producer. It verifies, installs, calls, and reopens that one
/// signed artifact rather than rebuilding guest bytes on the consumer.
#[test]
#[ignore = "cross-OS CI consumer; requires GENET_PORTABLE_FIXTURE_DIR"]
fn consume_linux_built_fixture_through_update_and_restart() {
    let directory = fixture_directory();
    let component = fs::read(directory.join(COMPONENT_FILE)).unwrap();
    let envelope: ArtifactEnvelope =
        serde_json::from_slice(&fs::read(directory.join(ENVELOPE_FILE)).unwrap()).unwrap();
    assert_eq!(envelope.module_id(), MODULE_ID);
    assert_eq!(envelope.key_id(), KEY_ID);
    assert_eq!(envelope.version(), PORTABLE_VERSION);
    let candidate = SignedArtifact::new(envelope, component);

    let state = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = PlatformRuntime::open(
        state.path(),
        verifier(&key, 4 * 1024 * 1024),
        VmPolicy::new(LOGIC_ABI_VERSION),
        fallback.clone(),
    )
    .unwrap();

    let installed = runtime.install(candidate).unwrap();
    assert_eq!(installed.version, PORTABLE_VERSION);
    assert_eq!(runtime.probe(100).unwrap(), 177);
    drop(runtime);

    let reopened = PlatformRuntime::open(
        state.path(),
        verifier(&key, 4 * 1024 * 1024),
        VmPolicy::new(LOGIC_ABI_VERSION),
        fallback,
    )
    .unwrap();
    assert_eq!(reopened.active().unwrap(), installed);
    assert_eq!(reopened.probe(-77).unwrap(), 0);
}

fn fixture_directory() -> PathBuf {
    std::env::var_os("GENET_PORTABLE_FIXTURE_DIR")
        .map(PathBuf::from)
        .expect("GENET_PORTABLE_FIXTURE_DIR must name the CI handoff directory")
}
