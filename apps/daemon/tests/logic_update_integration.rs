use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::{BufRead, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{extract::State, routing::get, Router};
use ed25519_dalek::{Signer, SigningKey};
use genehub_proto::{
    ArtifactDescriptor, ArtifactSource, LogicActivation, LogicManifest, PatchAvailability,
    PatchControlRequest, PatchControlResponse, ProbeState, Reply, Request, SessionSnapshot,
    SessionStatus, SourceRevision, TimelineItem, TransportKind, LOGIC_MANIFEST_SCHEMA,
};
use genet_daemon::config::Paths;
use genet_daemon::logic::ApplyArtifact;
use genet_daemon::patch::{PatchConfig, PatchService};
use genet_daemon::router;
use genet_daemon::Daemon;
use genet_daemon_logic_api::CallerContext;
use genet_daemon_platform::{ArtifactEnvelope, SignedArtifact, LOGIC_ABI_VERSION};
use serde_json::json;

const MODULE_ID: &str = "genehub:daemon/logic";
const KEY_ID: &str = "dev-local";
const FIXTURE_AGENT_ID: &str = "acp:cold-update-fixture";
const FIXTURE_AGENT_TEST: &str = "acp_fixture_agent_process";
const FIXTURE_AGENT_RECORD_ENV: &str = "GENET_DAEMON_TEST_AGENT_RECORD";
const FIXTURE_AGENT_OUTPUT: &str = "fixture-agent-output.txt";

fn serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn running_daemon_cold_updates_reject_tampering_and_replay_without_restart() {
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

    let next = sign(before.revision + 1, initial.component.clone());
    let installed = logic.apply_artifact(next.clone(), false).await.unwrap();
    let ApplyArtifact::Installed(installed) = installed else {
        panic!("an idle daemon rejected the candidate")
    };
    assert_eq!(installed.revision, before.revision + 1);
    assert_eq!(daemon.port, port);
    assert_eq!(std::process::id(), pid);

    // Identity is one of the routes actually owned by the guest, so this is a
    // product-path call after replacement rather than a VM-only probe.
    assert!(matches!(
        route_call(&daemon, Request::ConnectionIdentity).await,
        Ok(Reply::Hello(_))
    ));

    let mut tampered = next.to_single_file().unwrap();
    let middle = tampered.len() / 2;
    tampered[middle] ^= 1;
    assert!(SignedArtifact::from_single_file(&tampered).is_err());
    assert_eq!(logic.active().unwrap().revision, before.revision + 1);
    assert_eq!(daemon.port, port);

    let replay = sign(before.revision, initial.component);
    assert!(logic.apply_artifact(replay, false).await.is_err());
    assert_eq!(logic.active().unwrap().revision, before.revision + 1);
    assert_eq!(daemon.port, port);
    assert_eq!(std::process::id(), pid);

    daemon.shutdown().await;
}

/// Covers the update seam that component tests cannot: a real manifest and
/// signed single-file artifact cross HTTP, are admitted by PatchService, and
/// replace the live Rust guest while the daemon remains usable.
#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn signed_patch_feed_downloads_and_activates_real_guest_without_daemon_restart() {
    let _serial = serial().lock().await;
    let initial = SignedArtifact::from_single_file(&fs::read(artifact_path()).unwrap()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(Paths::new(directory.path())).await.unwrap();
    let logic = daemon.state.logic.as_ref().expect("real Wasm logic");
    let before = logic.active().unwrap();
    let pid = std::process::id();
    let port = daemon.port;

    let candidate = sign(before.revision + 1, initial.component);
    let artifact = candidate.to_single_file().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let manifest = LogicManifest {
        schema: LOGIC_MANIFEST_SCHEMA.into(),
        channel: candidate.envelope.channel().into(),
        logic_revision: candidate.envelope.logic_revision(),
        platform_abi: candidate.envelope.platform_abi(),
        protocol_version: candidate.envelope.protocol_version(),
        artifact: ArtifactDescriptor {
            sources: vec![ArtifactSource {
                url: format!("{origin}/daemon-logic.wasm"),
            }],
            sha256: candidate.envelope.sha256().into(),
            size: candidate.envelope.size(),
        },
        source: SourceRevision {
            open_sha: "a".repeat(40),
            cloud_sha: "b".repeat(40),
            lockfile_sha256: "c".repeat(64),
        },
        activation: LogicActivation {
            enabled: true,
            paused_reason: None,
        },
    };
    let bodies = Arc::new((serde_json::to_vec(&manifest).unwrap(), artifact));
    let router = Router::new()
        .route(
            "/latest.json",
            get(|State(bodies): State<Arc<(Vec<u8>, Vec<u8>)>>| async move { bodies.0.clone() }),
        )
        .route(
            "/daemon-logic.wasm",
            get(|State(bodies): State<Arc<(Vec<u8>, Vec<u8>)>>| async move { bodies.1.clone() }),
        )
        .with_state(bodies);
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let service = PatchService::new(PatchConfig::for_integration_test(
        "dev",
        format!("{origin}/latest.json"),
    ))
    .unwrap();

    let checked = service
        .handle(logic, PatchControlRequest::Check)
        .await
        .unwrap();
    assert!(matches!(
        checked,
        PatchControlResponse::Status {
            availability: PatchAvailability::Available { ref artifact },
            ..
        } if artifact.logic_revision == before.revision + 1
    ));
    let applied = service
        .handle(
            logic,
            PatchControlRequest::Apply {
                request_id: "patch_real_feed_contract".into(),
                terminate_activities: false,
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        applied,
        PatchControlResponse::Applied { ref active, .. }
            if active.logic_revision == before.revision + 1
    ));
    assert_eq!(logic.active().unwrap().revision, before.revision + 1);
    assert_eq!(std::process::id(), pid);
    assert_eq!(daemon.port, port);
    assert!(matches!(
        route_call(&daemon, Request::ConnectionIdentity).await,
        Ok(Reply::Hello(_))
    ));
    assert!(matches!(
        service
            .handle(logic, PatchControlRequest::Check)
            .await
            .unwrap(),
        PatchControlResponse::Status {
            availability: PatchAvailability::Current,
            ..
        }
    ));

    server.abort();
    daemon.shutdown().await;
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn daemon_start_refuses_to_open_a_listener_without_a_verified_artifact() {
    let _serial = serial().lock().await;
    let source = SignedArtifact::from_single_file(&fs::read(artifact_path()).unwrap()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    fs::create_dir_all(&data).unwrap();

    let reservation = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = reservation.local_addr().unwrap();
    drop(reservation);
    fs::write(
        data.join("config.json"),
        serde_json::to_vec_pretty(&json!({
            "port": address.port(),
            "lanEnabled": false,
        }))
        .unwrap(),
    )
    .unwrap();

    // Keep the single-file envelope structurally valid while invalidating the
    // digest/signature binding. Startup must reject these bytes before the
    // transport has a chance to bind its configured port.
    let component_len = source.component.len();
    let mut tampered = sign(source.envelope.logic_revision() + 1, source.component)
        .to_single_file()
        .unwrap();
    tampered[component_len / 2] ^= 1;
    let tampered_path = directory.path().join("tampered.wasm");
    fs::write(&tampered_path, tampered).unwrap();
    let _artifact = EnvVarGuard::set(
        genet_daemon::logic::ARTIFACT_PATH_ENV,
        tampered_path.as_os_str(),
    );

    let error = match Daemon::start(Paths::new(&data)).await {
        Ok(daemon) => {
            daemon.shutdown().await;
            panic!("a daemon started with an unverified artifact")
        }
        Err(error) => error,
    };
    assert!(
        format!("{error:#}").contains("artifact"),
        "startup failed for an unrelated reason: {error:#}"
    );
    assert!(
        !data.join("endpoint.json").exists(),
        "a failed start must not publish listener credentials"
    );
    let rebound = TcpListener::bind(address)
        .unwrap_or_else(|bind| panic!("failed startup left {address} occupied: {bind}"));
    drop(rebound);
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn a_live_agent_blocks_update_until_force_terminates_it() {
    let _serial = serial().lock().await;
    let source = SignedArtifact::from_single_file(&fs::read(artifact_path()).unwrap()).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    let workspace = directory.path().join("workspace");
    let records = directory.path().join("agent-records.jsonl");
    fs::create_dir_all(&workspace).unwrap();
    write_fixture_config(&data);
    let _record = EnvVarGuard::set(FIXTURE_AGENT_RECORD_ENV, records.as_os_str());
    let fixture_path = fixture_system_path();
    let _path = EnvVarGuard::set("PATH", fixture_path.as_os_str());

    let daemon = Daemon::start(Paths::new(&data)).await.unwrap();
    let daemon_pid = std::process::id();
    let port = daemon.port;
    let session_id = create_fixture_session(&daemon, &workspace, None).await;
    assert!(matches!(
        daemon_call(
            &daemon,
            Request::SessionSend {
                session_id: session_id.clone(),
                text: "first round".to_string(),
                attachments: Vec::new(),
                artifact_preview_base_url: None,
                continues_round: None,
            },
        )
        .await,
        Reply::Ack
    ));
    wait_for_session_text(&daemon, &session_id, "fixture round 1").await;
    let first_records = agent_records(&records);
    assert_eq!(first_records.len(), 1, "one live Agent handled the round");

    let before = daemon.state.logic.as_ref().unwrap().active().unwrap();
    let candidate = sign(before.revision + 1, source.component);
    let blocked = daemon
        .state
        .logic
        .as_ref()
        .unwrap()
        .apply_artifact(candidate.clone(), false)
        .await
        .unwrap();
    assert!(matches!(blocked, ApplyArtifact::Busy { .. }));
    assert_eq!(
        daemon.state.logic.as_ref().unwrap().active().unwrap(),
        before
    );

    let installed = daemon
        .state
        .logic
        .as_ref()
        .unwrap()
        .apply_artifact(candidate, true)
        .await
        .unwrap();
    let ApplyArtifact::Installed(installed) = installed else {
        panic!("force did not terminate active work")
    };
    assert_eq!(installed.revision, before.revision + 1);
    assert_eq!(daemon.port, port);
    assert_eq!(std::process::id(), daemon_pid);

    assert!(matches!(
        daemon_call(
            &daemon,
            Request::SessionSend {
                session_id: session_id.clone(),
                text: "second round".to_string(),
                attachments: Vec::new(),
                artifact_preview_base_url: None,
                continues_round: None,
            },
        )
        .await,
        Reply::Ack
    ));
    let snapshot = wait_for_session_text(&daemon, &session_id, "fixture round 2").await;
    let after_records = agent_records(&records);
    assert_eq!(after_records.len(), 2, "both prompts reached an Agent");
    assert_ne!(
        after_records[0].pid, after_records[1].pid,
        "a forced cold update must launch a new Agent process"
    );
    assert_eq!(after_records[0].cwd, after_records[1].cwd);
    assert!(snapshot.items.iter().any(
        |item| matches!(item, TimelineItem::AssistantMessage { text, .. } if text == "fixture round 1")
    ));
    assert_eq!(
        fs::read_to_string(workspace.join(FIXTURE_AGENT_OUTPUT)).unwrap(),
        "fixture round 2"
    );

    daemon.shutdown().await;
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn a_real_format_6_session_keeps_its_subdirectory_cwd_after_upgrade() {
    let _serial = serial().lock().await;
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    let workspace = directory.path().join("workspace");
    let cwd = workspace.join("services").join("api");
    let records = directory.path().join("agent-records.jsonl");
    fs::create_dir_all(&cwd).unwrap();
    write_fixture_config(&data);
    let _record = EnvVarGuard::set(FIXTURE_AGENT_RECORD_ENV, records.as_os_str());
    let fixture_path = fixture_system_path();
    let _path = EnvVarGuard::set("PATH", fixture_path.as_os_str());

    let daemon = Daemon::start(Paths::new(&data)).await.unwrap();
    let session_id = create_fixture_session(&daemon, &workspace, Some("services/api")).await;
    assert!(matches!(
        daemon_call(
            &daemon,
            Request::SessionSend {
                session_id: session_id.clone(),
                text: "before upgrade".to_string(),
                attachments: Vec::new(),
                artifact_preview_base_url: None,
                continues_round: None,
            },
        )
        .await,
        Reply::Ack
    ));
    wait_for_session_text(&daemon, &session_id, "fixture round 1").await;
    let output = cwd.join(FIXTURE_AGENT_OUTPUT);
    assert_eq!(fs::read_to_string(&output).unwrap(), "fixture round 1");
    fs::remove_file(&output).unwrap();

    // Recreate the exact durable shape written by format 6: the native cwd is
    // present, while the locator-safe cwdPath introduced by format 7 is not.
    let meta_path = workspace
        .join(".genethub")
        .join("sessions")
        .join(&session_id)
        .join("meta.json");
    let mut legacy: serde_json::Value =
        serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    let legacy_cwd = legacy["cwd"]
        .as_str()
        .expect("format 6 stores a native cwd");
    assert!(Path::new(legacy_cwd).ends_with(Path::new("services").join("api")));
    legacy["format"] = json!(6);
    legacy
        .as_object_mut()
        .expect("session metadata is an object")
        .remove("cwdPath");
    fs::write(&meta_path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();
    daemon.shutdown().await;

    let daemon = Daemon::start(Paths::new(&data)).await.unwrap();
    assert!(matches!(
        daemon_call(
            &daemon,
            Request::SessionSend {
                session_id: session_id.clone(),
                text: "after upgrade".to_string(),
                attachments: Vec::new(),
                artifact_preview_base_url: None,
                continues_round: None,
            },
        )
        .await,
        Reply::Ack
    ));
    wait_for_session_text(&daemon, &session_id, "fixture round 2").await;
    assert_eq!(
        fs::read_to_string(&output).unwrap(),
        "fixture round 2",
        "the upgraded session must still launch inside its original subdirectory"
    );
    assert!(
        !workspace.join(FIXTURE_AGENT_OUTPUT).exists(),
        "the legacy cwd must not collapse to the workspace root"
    );
    let migrated: serde_json::Value =
        serde_json::from_slice(&fs::read(&meta_path).unwrap()).unwrap();
    assert!(migrated["format"].as_u64().unwrap() > 6);
    assert_eq!(migrated["cwdPath"], "services/api");

    daemon.shutdown().await;
}

#[tokio::test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM naming the signed real Rust guest"]
async fn real_guest_owns_workspace_files_pty_settings_devices_and_catalog_end_to_end() {
    let _serial = serial().lock().await;
    let directory = tempfile::tempdir().unwrap();
    let workspace = directory.path().join("workspace");
    fs::create_dir_all(&workspace).unwrap();
    // macOS spells temporary directories through `/var`, whose canonical
    // filesystem identity is `/private/var`. Compare the same spelling the
    // native capability boundary registers and returns.
    let workspace = workspace.canonicalize().unwrap();
    let daemon = Daemon::start(Paths::new(directory.path().join("data")))
        .await
        .unwrap();

    let call = |request| route_call(&daemon, request);
    let opened = call(Request::WorkspaceOpen {
        root: workspace.display().to_string(),
    })
    .await
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
        .await,
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
        .await,
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
        .await,
        Ok(Reply::Settings(_))
    ));
    assert!(matches!(
        call(Request::DeviceInvite(None)).await,
        Ok(Reply::Invite(_))
    ));

    let pty = call(Request::PtyOpen {
        workspace_id: opened.id.clone(),
        cols: Some(80),
        rows: Some(24),
    })
    .await
    .unwrap();
    let Reply::Pty { pty_id } = pty else {
        panic!("pty.open returned the wrong reply")
    };
    assert!(matches!(
        call(Request::PtyClose { pty_id }).await,
        Ok(Reply::Ack)
    ));

    // Every operation above survives a full guest instance replacement; no
    // native business object is available to reconstruct it as a fallback.
    let initial = SignedArtifact::from_single_file(&fs::read(artifact_path()).unwrap()).unwrap();
    let before = daemon.state.logic.as_ref().unwrap().active().unwrap();
    assert!(matches!(
        daemon
            .state
            .logic
            .as_ref()
            .unwrap()
            .apply_artifact(sign(before.revision + 1, initial.component), false)
            .await
            .unwrap(),
        ApplyArtifact::Installed(_)
    ));
    assert!(matches!(
        call(Request::WorkspaceList).await,
        Ok(Reply::Workspaces(ref workspaces)) if workspaces.iter().any(|item| item.id == opened.id)
    ));
    assert!(matches!(
        call(Request::SettingsGet).await,
        Ok(Reply::Settings(ref settings)) if settings.providers.iter().any(|item| item.id == "test-provider")
    ));

    daemon.shutdown().await;
}

fn sign(revision: u64, component: Vec<u8>) -> SignedArtifact {
    let key = SigningKey::from_bytes(&[7; 32]);
    let envelope = ArtifactEnvelope::unsigned(
        MODULE_ID,
        "dev",
        revision,
        LOGIC_ABI_VERSION,
        genehub_proto::PROTOCOL_VERSION,
        KEY_ID,
        &component,
    )
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

struct EnvVarGuard {
    name: &'static str,
    previous: Option<OsString>,
}

impl EnvVarGuard {
    fn set(name: &'static str, value: &OsStr) -> Self {
        let previous = std::env::var_os(name);
        std::env::set_var(name, value);
        Self { name, previous }
    }
}

impl Drop for EnvVarGuard {
    fn drop(&mut self) {
        match self.previous.take() {
            Some(value) => std::env::set_var(self.name, value),
            None => std::env::remove_var(self.name),
        }
    }
}

fn fixture_system_path() -> OsString {
    let executable = std::env::current_exe().unwrap();
    let executable_dir = executable.parent().unwrap().to_path_buf();
    #[cfg(windows)]
    let paths = {
        let mut paths = vec![executable_dir];
        if let Some(root) = std::env::var_os("SystemRoot") {
            paths.push(PathBuf::from(root).join("System32"));
        }
        paths
    };
    #[cfg(not(windows))]
    let paths = vec![
        executable_dir,
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    std::env::join_paths(paths).unwrap()
}

fn write_fixture_config(data: &Path) {
    fs::create_dir_all(data).unwrap();
    let command = vec![
        std::env::current_exe().unwrap().display().to_string(),
        "--exact".to_string(),
        FIXTURE_AGENT_TEST.to_string(),
        "--nocapture".to_string(),
    ];
    fs::write(
        data.join("config.json"),
        serde_json::to_vec_pretty(&json!({
            "port": 0,
            "lanEnabled": false,
            "agents": {
                "custom": {
                    "cold-update-fixture": {
                        "extends": "acp",
                        "command": command,
                        "label": "Cold update fixture"
                    }
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

async fn daemon_call(daemon: &Daemon, request: Request) -> Reply {
    route_call(daemon, request).await.unwrap()
}

async fn route_call(
    daemon: &Daemon,
    request: Request,
) -> Result<Reply, genehub_proto::ProtocolError> {
    let handled = router::handle(
        &daemon.state,
        TransportKind::Loopback,
        CallerContext::LocalUser,
        Default::default(),
        serde_json::to_vec(&request).unwrap(),
    )
    .await;
    if handled.response.status < 400 {
        serde_json::from_slice(&handled.response.body).map_err(|error| {
            genehub_proto::ProtocolError {
                code: genehub_proto::ErrorCode::Internal,
                message: format!("invalid test reply: {error}"),
            }
        })
    } else {
        serde_json::from_slice(handled.response.error.as_deref().unwrap_or_default()).map_err(
            |error| genehub_proto::ProtocolError {
                code: genehub_proto::ErrorCode::Internal,
                message: format!("invalid test error: {error}"),
            },
        )
    }
}

async fn create_fixture_session(daemon: &Daemon, workspace: &Path, cwd: Option<&str>) -> String {
    let Reply::Agents(agents) = daemon_call(daemon, Request::AgentList).await else {
        panic!("agent.list returned the wrong reply")
    };
    assert!(agents
        .iter()
        .any(|agent| agent.id == FIXTURE_AGENT_ID && matches!(agent.probe, ProbeState::Ready)));
    let Reply::Workspace(workspace) = daemon_call(
        daemon,
        Request::WorkspaceOpen {
            root: workspace.display().to_string(),
        },
    )
    .await
    else {
        panic!("workspace.open returned the wrong reply")
    };
    let Reply::Session(session) = daemon_call(
        daemon,
        Request::SessionCreate {
            workspace_id: workspace.id,
            agent_id: FIXTURE_AGENT_ID.to_string(),
            model_id: None,
            mode_id: None,
            title: None,
            cwd: cwd.map(str::to_string),
        },
    )
    .await
    else {
        panic!("session.create returned the wrong reply")
    };
    session.id
}

async fn wait_for_session_text(
    daemon: &Daemon,
    session_id: &str,
    expected: &str,
) -> SessionSnapshot {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last = None;
    while Instant::now() < deadline {
        let reply = daemon_call(
            daemon,
            Request::SessionGet {
                session_id: session_id.to_string(),
            },
        )
        .await;
        let Reply::Snapshot(snapshot) = reply else {
            panic!("session.get returned the wrong reply: {reply:?}")
        };
        let complete = snapshot.summary.status == SessionStatus::Idle
            && snapshot.items.iter().any(
                |item| matches!(item, TimelineItem::AssistantMessage { text, .. } if text == expected),
            );
        if complete {
            return snapshot;
        }
        last = Some(snapshot);
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("session did not settle with {expected:?}; last snapshot: {last:?}")
}

#[derive(Debug)]
struct AgentRecord {
    pid: u32,
    cwd: String,
}

fn agent_records(path: &Path) -> Vec<AgentRecord> {
    fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            AgentRecord {
                pid: value["pid"].as_u64().unwrap() as u32,
                cwd: value["cwd"].as_str().unwrap().to_string(),
            }
        })
        .collect()
}

#[test]
fn acp_fixture_agent_process() {
    let args = std::env::args().collect::<Vec<_>>();
    let selected = args
        .windows(2)
        .any(|pair| pair[0] == "--exact" && pair[1] == FIXTURE_AGENT_TEST);
    let Some(record_path) = std::env::var_os(FIXTURE_AGENT_RECORD_ENV) else {
        return;
    };
    if !selected {
        return;
    }

    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line.unwrap();
        let Ok(frame) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(method) = frame.get("method").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let id = frame.get("id").cloned().unwrap_or(serde_json::Value::Null);
        match method {
            "initialize" => emit_acp(
                &mut stdout,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": {
                        "protocolVersion": 1,
                        "agentCapabilities": { "sessionCapabilities": { "resume": {} } }
                    }
                }),
            ),
            "session/new" | "session/resume" | "session/load" => emit_acp(
                &mut stdout,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "sessionId": "fixture-session" }
                }),
            ),
            "session/set_mode" | "session/set_config_option" => emit_acp(
                &mut stdout,
                json!({ "jsonrpc": "2.0", "id": id, "result": {} }),
            ),
            "session/prompt" => {
                let round = record_fixture_prompt(Path::new(&record_path));
                let text = format!("fixture round {round}");
                emit_acp(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "method": "session/update",
                        "params": {
                            "sessionId": "fixture-session",
                            "update": {
                                "sessionUpdate": "agent_message_chunk",
                                "content": { "text": text }
                            }
                        }
                    }),
                );
                emit_acp(
                    &mut stdout,
                    json!({
                        "jsonrpc": "2.0",
                        "id": id,
                        "result": { "stopReason": "end_turn" }
                    }),
                );
            }
            _ if !id.is_null() => emit_acp(
                &mut stdout,
                json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32601, "message": "unsupported fixture method" }
                }),
            ),
            _ => {}
        }
    }
}

fn emit_acp(output: &mut impl Write, value: serde_json::Value) {
    serde_json::to_writer(&mut *output, &value).unwrap();
    output.write_all(b"\n").unwrap();
    output.flush().unwrap();
}

fn record_fixture_prompt(path: &Path) -> usize {
    let round = fs::read_to_string(path).unwrap_or_default().lines().count() + 1;
    let cwd = std::env::current_dir().unwrap();
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .unwrap();
    serde_json::to_writer(
        &mut output,
        &json!({
            "round": round,
            "pid": std::process::id(),
            "cwd": cwd.display().to_string(),
        }),
    )
    .unwrap();
    output.write_all(b"\n").unwrap();
    output.flush().unwrap();
    fs::write(
        cwd.join(FIXTURE_AGENT_OUTPUT),
        format!("fixture round {round}"),
    )
    .unwrap();
    round
}
