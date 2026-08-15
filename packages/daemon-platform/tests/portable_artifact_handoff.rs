mod support;

use std::fs;
use std::path::PathBuf;

use genet_daemon_platform::{
    ArtifactVerifier, PlatformRuntime, SignedArtifact, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{healthy_component, signed_component_with_key_id, signing_key, MODULE_ID};

const COMPONENT_FILE: &str = "daemon-logic.wasm";
const PORTABLE_VERSION: &str = "portable-linux-ci";
const KEY_ID: &str = "dev-local";

/// A producer-side assertion for the exact application artifact that Linux
/// built and signed. Packaging itself is done by `genet-daemon-artifact`; the
/// test never rewrites the handoff bytes.
#[test]
#[ignore = "CI fixture producer; requires GENET_PORTABLE_FIXTURE_DIR"]
fn write_linux_portable_fixture() {
    let directory = fixture_directory();
    let component_path = directory.join(COMPONENT_FILE);
    let bytes = fs::read(&component_path).expect("Linux must create the signed guest first");
    let artifact = SignedArtifact::from_single_file(&bytes).unwrap();
    assert_eq!(artifact.envelope.module_id(), MODULE_ID);
    assert_eq!(artifact.envelope.key_id(), KEY_ID);
    assert_eq!(artifact.envelope.version(), PORTABLE_VERSION);
    assert_eq!(artifact.to_single_file().unwrap(), bytes);
}

/// This test runs on Linux, Windows and macOS against the exact files uploaded
/// by the Linux producer. It verifies, installs, calls, and reopens that one
/// signed artifact rather than rebuilding guest bytes on the consumer.
#[test]
#[ignore = "cross-OS CI consumer; requires GENET_PORTABLE_FIXTURE_DIR"]
fn consume_linux_built_fixture_through_update_and_restart() {
    let directory = fixture_directory();
    let candidate =
        SignedArtifact::from_single_file(&fs::read(directory.join(COMPONENT_FILE)).unwrap())
            .unwrap();
    assert_eq!(candidate.envelope.module_id(), MODULE_ID);
    assert_eq!(candidate.envelope.key_id(), KEY_ID);
    assert_eq!(candidate.envelope.version(), PORTABLE_VERSION);

    let state = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let verifier = ArtifactVerifier::new(
        MODULE_ID,
        LOGIC_ABI_VERSION,
        16 * 1024 * 1024,
        [(KEY_ID.to_string(), key.verifying_key())],
    )
    .unwrap();
    let fallback = signed_component_with_key_id(&key, KEY_ID, "embedded", healthy_component(1));
    let runtime = PlatformRuntime::open(
        state.path(),
        verifier.clone(),
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
        verifier,
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
