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

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn running_daemon_hot_updates_rejects_tampering_and_rolls_back_without_restart() {
    let _serial = serial().lock().await;
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

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn real_guest_owns_workspace_files_pty_settings_devices_and_catalog_end_to_end() {
    let _serial = serial().lock().await;
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    let daemon = Daemon::start(Paths::new(directory.path().join("data")))
        .await
        .unwrap();

    let call = |request| router::handle(&daemon.state, TransportKind::Loopback, request);
    let opened = call(Request::WorkspaceOpen {
        root: workspace.display().to_string(),
    })
    .await
    .reply
    .unwrap();
    let Reply::Workspace(opened) = opened else {
        panic!("workspace.open returned the wrong reply")
    };
    let folder = opened.folders.first().unwrap();
    let file = format!("{}/notes/readme.txt", folder.root_handle);

    assert!(matches!(
        call(Request::FileWrite {
            workspace_id: opened.id.clone(),
            path: file.clone(),
            content: "portable application".into(),
        })
        .await
        .reply,
        Ok(Reply::Ack)
    ));
    assert_eq!(
        fs::read_to_string(workspace.join("notes/readme.txt")).unwrap(),
        "portable application"
    );
    assert!(matches!(
        call(Request::FileTree {
            workspace_id: opened.id.clone(),
            path: Some(folder.root_handle.clone()),
            depth: Some(3),
        })
        .await
        .reply,
        Ok(Reply::FileTree(_))
    ));

    let logic = daemon.state.logic.as_ref().unwrap();
    let catalog = logic.workspace_catalog().await.unwrap();
    assert!(catalog
        .workspaces
        .iter()
        .any(|workspace| workspace.local_workspace_id == opened.id));
    assert_eq!(
        logic
            .resolve_workspace_file(opened.id.clone(), file)
            .await
            .unwrap(),
        workspace.join("notes/readme.txt")
    );

    assert!(matches!(
        call(Request::SettingsSetProvider {
            provider_id: "test-provider".into(),
            api_key: Some("secret".into()),
            base_url: Some("https://provider.example/v1".into()),
            label: Some("Test".into()),
            dialect: Some("openai".into()),
            models: Some(vec!["test-model".into()]),
        })
        .await
        .reply,
        Ok(Reply::Settings(_))
    ));
    assert!(matches!(
        call(Request::DeviceInvite).await.reply,
        Ok(Reply::Invite(_))
    ));

    let pty = call(Request::PtyOpen {
        workspace_id: opened.id.clone(),
        cols: Some(80),
        rows: Some(24),
    })
    .await
    .reply
    .unwrap();
    let Reply::Pty { pty_id } = pty else {
        panic!("pty.open returned the wrong reply")
    };
    assert!(matches!(
        call(Request::PtyClose { pty_id }).await.reply,
        Ok(Reply::Ack)
    ));

    // Every operation above survives a full guest instance replacement; no
    // native business object is available to reconstruct it as a fallback.
    let initial = SignedArtifact::from_single_file(&fs::read(artifact_path()).unwrap()).unwrap();
    let next_path = directory.path().join("next.wasm");
    fs::write(
        &next_path,
        sign("stateful-update", initial.component)
            .to_single_file()
            .unwrap(),
    )
    .unwrap();
    assert!(matches!(
        call(Request::DaemonLogicInstall {
            path: next_path.display().to_string(),
        })
        .await
        .reply,
        Ok(Reply::LogicModule(_))
    ));
    assert!(matches!(
        call(Request::WorkspaceList).await.reply,
        Ok(Reply::Workspaces(ref workspaces)) if workspaces.iter().any(|item| item.id == opened.id)
    ));
    assert!(matches!(
        call(Request::SettingsGet).await.reply,
        Ok(Reply::Settings(ref settings)) if settings.providers.iter().any(|item| item.id == "test-provider")
    ));

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
