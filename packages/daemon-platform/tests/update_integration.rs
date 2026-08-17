mod support;

use std::fs;
use std::sync::{Arc, Barrier};
use std::thread;

use genet_daemon_platform::{
    ActiveOrigin, PlatformError, PlatformRuntime, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{
    component, healthy_component, signed_component, signing_key, verifier, ComponentSpec,
};

#[test]
fn embedded_install_and_restart_use_one_active_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());

    let initial = runtime.active().unwrap();
    assert_eq!(initial.revision, 1);
    assert_eq!(initial.origin, ActiveOrigin::Embedded);
    assert_eq!(runtime.highest_accepted_revision().unwrap(), 1);
    assert_eq!(runtime.probe(10).unwrap(), 11);

    let installed = runtime
        .install(signed_component(&key, 2, healthy_component(2)))
        .unwrap();
    assert_eq!(installed.revision, 2);
    assert_eq!(installed.origin, ActiveOrigin::Installed);
    assert_eq!(runtime.probe(10).unwrap(), 12);
    drop(runtime);

    let reopened = open_runtime(directory.path(), &key, fallback);
    assert_eq!(reopened.active().unwrap(), installed);
    assert_eq!(reopened.probe(10).unwrap(), 12);
    assert_eq!(
        fs::read_dir(directory.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().to_string())
            .collect::<std::collections::BTreeSet<_>>(),
        ["active.wasm".to_string(), "highest-revision".to_string()]
            .into_iter()
            .collect()
    );
}

#[test]
fn candidate_failure_never_changes_active_or_high_water() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    let initial = runtime.active().unwrap();

    let malformed = signed_component(&key, 2, b"not wasm".to_vec());
    assert!(matches!(
        runtime.install(malformed),
        Err(PlatformError::Vm(_))
    ));

    let unhealthy = signed_component(
        &key,
        2,
        component(ComponentSpec {
            self_check_body: "unreachable".to_string(),
            ..ComponentSpec::default()
        }),
    );
    assert!(matches!(
        runtime.install(unhealthy),
        Err(PlatformError::Vm(_))
    ));

    let mut tampered = signed_component(&key, 2, healthy_component(3));
    tampered.component.push(0);
    assert!(matches!(
        runtime.install(tampered),
        Err(PlatformError::Verification(_))
    ));
    assert_eq!(runtime.active().unwrap(), initial);
    assert_eq!(runtime.highest_accepted_revision().unwrap(), 1);

    drop(runtime);
    let reopened = open_runtime(directory.path(), &key, fallback);
    assert_eq!(reopened.active().unwrap(), initial);
}

#[test]
fn replay_is_rejected_and_equal_revision_can_repair_corruption() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let revision_two = signed_component(&key, 2, healthy_component(2));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    runtime.install(revision_two.clone()).unwrap();

    assert!(matches!(
        runtime.install(signed_component(&key, 1, healthy_component(9))),
        Err(PlatformError::RevisionReplay {
            candidate: 1,
            highest: 2
        })
    ));
    drop(runtime);

    fs::write(directory.path().join("active.wasm"), b"corrupted").unwrap();
    let recovered = open_runtime(directory.path(), &key, fallback.clone());
    assert_eq!(recovered.active().unwrap().revision, 1);
    assert_eq!(recovered.active().unwrap().origin, ActiveOrigin::Recovered);
    assert_eq!(recovered.highest_accepted_revision().unwrap(), 2);
    assert!(matches!(
        recovered.install(signed_component(&key, 1, healthy_component(1))),
        Err(PlatformError::RevisionReplay { .. })
    ));

    let repaired = recovered.install(revision_two).unwrap();
    assert_eq!(repaired.revision, 2);
    assert_eq!(recovered.probe(10).unwrap(), 12);
}

#[test]
fn staged_candidate_is_completed_after_the_high_water_crash_point() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let candidate = signed_component(&key, 2, healthy_component(2));
    let runtime = open_runtime(directory.path(), &key, fallback.clone());
    drop(runtime);

    fs::write(
        directory.path().join("candidate.wasm"),
        candidate.to_single_file().unwrap(),
    )
    .unwrap();
    fs::write(directory.path().join("highest-revision"), b"2\n").unwrap();

    let recovered = open_runtime(directory.path(), &key, fallback);
    assert_eq!(recovered.active().unwrap().revision, 2);
    assert_eq!(recovered.probe(10).unwrap(), 12);
    assert!(!directory.path().join("candidate.wasm").exists());
}

#[test]
fn active_trap_does_not_roll_back_or_lower_revision() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, fallback);
    let trapping = signed_component(
        &key,
        2,
        component(ComponentSpec {
            probe_body: "unreachable".to_string(),
            ..ComponentSpec::default()
        }),
    );

    runtime.install(trapping).unwrap();
    assert!(matches!(runtime.probe(10), Err(PlatformError::Vm(_))));
    assert_eq!(runtime.active().unwrap().revision, 2);
    assert_eq!(runtime.highest_accepted_revision().unwrap(), 2);
    assert!(matches!(runtime.probe(10), Err(PlatformError::Vm(_))));
}

#[test]
fn a_newer_app_baseline_advances_the_fence_and_discards_old_active() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let old_baseline = signed_component(&key, 1, healthy_component(1));
    let runtime = open_runtime(directory.path(), &key, old_baseline);
    runtime
        .install(signed_component(&key, 2, healthy_component(2)))
        .unwrap();
    drop(runtime);

    let new_baseline = signed_component(&key, 3, healthy_component(3));
    let upgraded = open_runtime(directory.path(), &key, new_baseline);
    assert_eq!(upgraded.active().unwrap().revision, 3);
    assert_eq!(upgraded.active().unwrap().origin, ActiveOrigin::Embedded);
    assert_eq!(upgraded.highest_accepted_revision().unwrap(), 3);
    assert_eq!(upgraded.probe(10).unwrap(), 13);
    assert!(!directory.path().join("active.wasm").exists());
}

#[test]
fn concurrent_installs_are_linearized_by_revision() {
    let directory = tempfile::tempdir().unwrap();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, healthy_component(1));
    let runtime = Arc::new(open_runtime(directory.path(), &key, fallback));
    let barrier = Arc::new(Barrier::new(3));
    let mut installers = Vec::new();

    for (revision, delta) in [(2, 2), (3, 3)] {
        let runtime = Arc::clone(&runtime);
        let barrier = Arc::clone(&barrier);
        let candidate = signed_component(&key, revision, healthy_component(delta));
        installers.push(thread::spawn(move || {
            barrier.wait();
            runtime.install(candidate)
        }));
    }
    barrier.wait();
    let results = installers
        .into_iter()
        .map(|installer| installer.join().unwrap())
        .collect::<Vec<_>>();

    assert_eq!(runtime.active().unwrap().revision, 3);
    assert_eq!(runtime.highest_accepted_revision().unwrap(), 3);
    assert!(results.iter().any(|result| result.is_ok()));
    assert!(results.iter().all(|result| {
        result.is_ok() || matches!(result, Err(PlatformError::RevisionReplay { .. }))
    }));
    assert_eq!(runtime.probe(10).unwrap(), 13);
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
