mod support;

use std::fs;
use std::sync::{Arc, Barrier};
use std::thread;

use genet_daemon_platform::{
    ActiveOrigin, ArtifactVerifier, PlatformError, PlatformRuntime, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{
    component, healthy_component, signed_component, signed_component_with_key_id, signing_key,
    verifier, ComponentSpec, MODULE_ID,
};

#[test]
fn embedded_boot_install_restart_and_explicit_rollback_form_one_transactional_chain() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());

    let initial = runtime.active().unwrap();
    assert_eq!(initial.version, "embedded");
    assert_eq!(initial.origin, ActiveOrigin::Embedded);
    assert_eq!(initial.generation, 1);
    assert_eq!(runtime.probe(10).unwrap(), 11);

    let installed = runtime
        .install(signed_component(&key, "2.0.0", healthy_component(2)))
        .unwrap();
    assert_eq!(installed.version, "2.0.0");
    assert_eq!(installed.origin, ActiveOrigin::Installed);
    assert_eq!(installed.generation, 2);
    assert_eq!(runtime.probe(10).unwrap(), 12);

    drop(runtime);
    let reopened = open_runtime(directory.path(), &key, fallback);
    assert_eq!(reopened.active().unwrap().version, "2.0.0");
    assert_eq!(reopened.active().unwrap().generation, 2);
    assert_eq!(reopened.probe(10).unwrap(), 12);

    let rolled_back = reopened.rollback().unwrap();
    assert_eq!(rolled_back.version, "embedded");
    assert_eq!(rolled_back.origin, ActiveOrigin::Recovered);
    assert_eq!(rolled_back.generation, 3);
    assert_eq!(reopened.probe(10).unwrap(), 11);
}

#[test]
fn rejected_candidate_never_changes_the_live_or_durable_slot() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    let initial = runtime.active().unwrap();

    let malformed = signed_component(&key, "broken-binary", b"not wasm".to_vec());
    assert!(matches!(
        runtime.install(malformed),
        Err(PlatformError::Vm(_))
    ));
    assert_eq!(runtime.active().unwrap(), initial);

    let unhealthy = signed_component(
        &key,
        "broken-health",
        component(ComponentSpec {
            self_check_body: "unreachable".to_string(),
            ..ComponentSpec::default()
        }),
    );
    assert!(matches!(
        runtime.install(unhealthy),
        Err(PlatformError::Vm(_))
    ));
    assert_eq!(runtime.active().unwrap(), initial);

    let mut tampered = signed_component(&key, "bad-signature", healthy_component(3));
    tampered.component.push(0);
    assert!(matches!(
        runtime.install(tampered),
        Err(PlatformError::Verification(_))
    ));
    assert_eq!(runtime.active().unwrap(), initial);
    assert_eq!(runtime.probe(10).unwrap(), 11);

    drop(runtime);
    let reopened = open_runtime(directory.path(), &key, fallback);
    assert_eq!(reopened.active().unwrap(), initial);
}

#[test]
fn active_trap_poisoning_automatically_routes_back_to_previous_version() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback);
    let trapping = signed_component(
        &key,
        "trapping",
        component(ComponentSpec {
            probe_body: "unreachable".to_string(),
            ..ComponentSpec::default()
        }),
    );

    runtime.install(trapping).unwrap();
    assert!(matches!(runtime.probe(10), Err(PlatformError::Vm(_))));
    let recovered = runtime.active().unwrap();
    assert_eq!(recovered.version, "embedded");
    assert_eq!(recovered.origin, ActiveOrigin::Recovered);
    assert_eq!(recovered.generation, 3);
    assert_eq!(runtime.probe(10).unwrap(), 11);
}

#[test]
fn reopen_ignores_torn_state_and_recovers_from_corrupted_active_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    let installed = runtime
        .install(signed_component(&key, "2.0.0", healthy_component(2)))
        .unwrap();
    drop(runtime);

    let torn = directory
        .path()
        .join("states/state-00000000000000000003.json");
    fs::write(&torn, b"{\"generation\":").unwrap();
    let reopened = open_runtime(directory.path(), &key, fallback.clone());
    assert_eq!(reopened.active().unwrap().version, "2.0.0");
    assert_eq!(reopened.active().unwrap().generation, 2);
    drop(reopened);

    let active_path = directory
        .path()
        .join("artifacts")
        .join(format!("{}.wasm", installed.digest));
    fs::write(active_path, b"corrupted after activation").unwrap();
    let recovered = open_runtime(directory.path(), &key, fallback);
    let active = recovered.active().unwrap();
    assert_eq!(active.version, "embedded");
    assert_eq!(active.origin, ActiveOrigin::Recovered);
    assert_eq!(active.generation, 4);
    assert_eq!(recovered.probe(10).unwrap(), 11);
}

#[test]
fn concurrent_calls_observe_only_complete_old_or_new_instances() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = Arc::new(open_runtime(directory.path(), &key, fallback));
    let barrier = Arc::new(Barrier::new(9));
    let mut workers = Vec::new();

    for _ in 0..8 {
        let runtime = Arc::clone(&runtime);
        let barrier = Arc::clone(&barrier);
        workers.push(thread::spawn(move || {
            barrier.wait();
            (0..200)
                .map(|_| runtime.probe(100).unwrap())
                .collect::<Vec<_>>()
        }));
    }
    barrier.wait();
    runtime
        .install(signed_component(&key, "2.0.0", healthy_component(2)))
        .unwrap();

    let outputs = workers
        .into_iter()
        .flat_map(|worker| worker.join().unwrap())
        .collect::<Vec<_>>();
    assert!(!outputs.is_empty());
    assert!(outputs.iter().all(|output| matches!(output, 101 | 102)));
    assert_eq!(runtime.active().unwrap().version, "2.0.0");
    assert_eq!(runtime.probe(100).unwrap(), 102);
}

#[test]
fn reinstalling_identical_content_refreshes_instance_without_slot_churn() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    let before = runtime.active().unwrap();

    let refreshed = runtime.install(fallback).unwrap();
    assert_eq!(refreshed, before);
    assert_eq!(runtime.active().unwrap(), before);
    assert_eq!(runtime.probe(1).unwrap(), 2);
}

#[test]
fn same_component_can_be_republished_and_reopened_after_signing_key_rotation() {
    let directory = tempfile::tempdir().unwrap();
    let old_key = signing_key(7);
    let new_key = signing_key(9);
    let component = healthy_component(1);
    let fallback =
        signed_component_with_key_id(&old_key, "old-release-key", "embedded", component.clone());
    let rotated = signed_component_with_key_id(&new_key, "new-release-key", "2.0.0", component);
    let trusted = ArtifactVerifier::new(
        MODULE_ID,
        LOGIC_ABI_VERSION,
        4 * 1024 * 1024,
        [
            ("old-release-key".to_string(), old_key.verifying_key()),
            ("new-release-key".to_string(), new_key.verifying_key()),
        ],
    )
    .unwrap();
    let runtime = PlatformRuntime::open(
        directory.path(),
        trusted.clone(),
        VmPolicy::new(LOGIC_ABI_VERSION),
        fallback.clone(),
    )
    .unwrap();
    let before = runtime.active().unwrap();

    let installed = runtime.install(rotated).unwrap();
    assert_eq!(installed.version, "2.0.0");
    assert_eq!(installed.digest, before.digest);
    assert_ne!(installed.artifact_id, before.artifact_id);
    assert_eq!(
        fs::read_dir(directory.path().join("artifacts"))
            .unwrap()
            .count(),
        1
    );
    assert_eq!(
        fs::read_dir(directory.path().join("envelopes"))
            .unwrap()
            .count(),
        2
    );

    drop(runtime);
    let reopened = PlatformRuntime::open(
        directory.path(),
        trusted,
        VmPolicy::new(LOGIC_ABI_VERSION),
        fallback,
    )
    .unwrap();
    assert_eq!(reopened.active().unwrap(), installed);
    assert_eq!(reopened.probe(1).unwrap(), 2);
    assert_eq!(reopened.rollback().unwrap().version, "embedded");
}

#[test]
fn embedded_copy_repairs_corrupted_content_addressed_storage() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    let active = runtime.active().unwrap();
    drop(runtime);

    fs::write(
        directory
            .path()
            .join("artifacts")
            .join(format!("{}.wasm", active.digest)),
        b"corrupted component",
    )
    .unwrap();
    fs::write(
        directory
            .path()
            .join("envelopes")
            .join(format!("{}.json", active.artifact_id)),
        b"corrupted envelope",
    )
    .unwrap();

    let repaired = open_runtime(directory.path(), &key, fallback);
    assert_eq!(repaired.active().unwrap().version, "embedded");
    assert_eq!(repaired.probe(10).unwrap(), 11);
}

#[test]
fn concurrent_installs_are_linearized_and_preserve_the_immediate_previous_version() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = Arc::new(open_runtime(directory.path(), &key, fallback));
    let barrier = Arc::new(Barrier::new(3));
    let mut installers = Vec::new();

    for (version, delta) in [("2.0.0", 2), ("3.0.0", 3)] {
        let runtime = Arc::clone(&runtime);
        let barrier = Arc::clone(&barrier);
        let candidate = signed_component(&key, version, healthy_component(delta));
        installers.push(thread::spawn(move || {
            barrier.wait();
            runtime.install(candidate).unwrap()
        }));
    }
    barrier.wait();
    let installed = installers
        .into_iter()
        .map(|installer| installer.join().unwrap())
        .collect::<Vec<_>>();

    let active = runtime.active().unwrap();
    assert_eq!(active.generation, 3);
    assert!(installed.iter().any(|info| info == &active));
    let expected_previous = installed
        .iter()
        .find(|info| info.artifact_id != active.artifact_id)
        .unwrap();
    let rolled_back = runtime.rollback().unwrap();
    assert_eq!(rolled_back.version, expected_previous.version);
    assert_eq!(rolled_back.artifact_id, expected_previous.artifact_id);
    assert_eq!(rolled_back.generation, 4);
}

#[test]
fn rollback_without_a_previous_slot_is_explicitly_rejected() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback);

    assert!(matches!(
        runtime.rollback(),
        Err(PlatformError::NoPreviousArtifact)
    ));
    assert_eq!(runtime.probe(1).unwrap(), 2);
}

fn open_runtime(
    path: &std::path::Path,
    key: &ed25519_dalek::SigningKey,
    fallback: genet_daemon_platform::SignedArtifact,
) -> PlatformRuntime {
    PlatformRuntime::open(
        path,
        verifier(key, 4 * 1024 * 1024),
        VmPolicy::new(LOGIC_ABI_VERSION),
        fallback,
    )
    .unwrap()
}
