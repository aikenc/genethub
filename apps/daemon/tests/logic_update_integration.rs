use std::fs;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signer, SigningKey};
use genehub_proto::{Reply, Request, TransportKind};
use genet_daemon::config::Paths;
use genet_daemon::router;
use genet_daemon::Daemon;
use genet_daemon_platform::{ArtifactEnvelope, SignedArtifact, LOGIC_ABI_VERSION};

const MODULE_ID: &str = "genehub:daemon/logic";
const KEY_ID: &str = "dev-local";

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn running_daemon_hot_updates_rejects_tampering_and_rolls_back_without_restart() {
    let source = artifact_path();
    let initial_file = fs::read(&source).unwrap();
    let initial = SignedArtifact::from_single_file(&initial_file).unwrap();
    assert_eq!(initial.envelope.key_id(), KEY_ID);

    let directory = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(Paths::new(directory.path())).await.unwrap();
    let pid = std::process::id();
    let port = daemon.port;
    let logic = daemon.state.logic.as_ref().expect("real Wasm logic");
    let before = logic.active().unwrap();

    let next_path = directory.path().join("next.wasm");
    fs::write(
        &next_path,
        sign("hot-update", initial.component.clone())
            .to_single_file()
            .unwrap(),
    )
    .unwrap();
    let installed = router::handle(
        &daemon.state,
        TransportKind::Loopback,
        Request::DaemonLogicInstall {
            path: next_path.display().to_string(),
        },
    )
    .await;
    let Reply::LogicModule(installed) = installed.reply.unwrap() else {
        panic!("install returned the wrong reply")
    };
    assert_eq!(installed.version.as_deref(), Some("hot-update"));
    assert_eq!(installed.generation, before.generation + 1);
    assert_eq!(daemon.port, port);
    assert_eq!(std::process::id(), pid);

    // Identity is one of the routes actually owned by the guest, so this is a
    // product-path call after replacement rather than a VM-only probe.
    let identity = router::handle(
        &daemon.state,
        TransportKind::Loopback,
        Request::ConnectionIdentity,
    )
    .await;
    assert!(matches!(identity.reply, Ok(Reply::Hello(_))));

    let mut tampered = fs::read(&next_path).unwrap();
    let middle = tampered.len() / 2;
    tampered[middle] ^= 1;
    let tampered_path = directory.path().join("tampered.wasm");
    fs::write(&tampered_path, tampered).unwrap();
    let rejected = router::handle(
        &daemon.state,
        TransportKind::Loopback,
        Request::DaemonLogicInstall {
            path: tampered_path.display().to_string(),
        },
    )
    .await;
    assert!(rejected.reply.is_err());
    assert_eq!(logic.active().unwrap().version, "hot-update");
    assert_eq!(daemon.port, port);

    let remote = router::handle(
        &daemon.state,
        TransportKind::Forwarded,
        Request::DaemonLogicRollback,
    )
    .await;
    assert!(remote.reply.is_err());
    assert_eq!(logic.active().unwrap().version, "hot-update");

    let rolled_back = router::handle(
        &daemon.state,
        TransportKind::Loopback,
        Request::DaemonLogicRollback,
    )
    .await;
    let Reply::LogicModule(rolled_back) = rolled_back.reply.unwrap() else {
        panic!("rollback returned the wrong reply")
    };
    assert_eq!(
        rolled_back.version.as_deref(),
        Some(before.version.as_str())
    );
    assert_eq!(daemon.port, port);
    assert_eq!(std::process::id(), pid);

    daemon.shutdown().await;
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
    std::env::var_os(genet_daemon::logic::ARTIFACT_PATH_ENV)
        .map(PathBuf::from)
        .filter(|path| Path::new(path).is_file())
        .expect("GENET_DAEMON_LOGIC_WASM must name the signed real Rust guest")
}
