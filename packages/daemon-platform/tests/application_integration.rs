mod support;

use std::fs;
use std::path::PathBuf;

use genehub_proto::{Reply, Request, TransportKind, PROTOCOL_VERSION};
use genet_daemon_logic_api::{
    decode_message, encode_message, LogicBoot, LogicInput, LogicOutcome, LogicOutput, LogicRequest,
};
use genet_daemon_platform::{
    LogicVm, PlatformRuntime, SignedArtifact, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{signed_component, signing_key, verifier};

#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM built for wasm32-wasip1"]
fn real_rust_application_runs_statefully_and_restores_across_instances() {
    let component = application_component();
    let logs = tempfile::tempdir().unwrap();
    let vm = LogicVm::new(application_policy(logs.path())).unwrap();
    let first = vm.instantiate(&component).unwrap();
    first.initialize(&boot_bytes()).unwrap();

    let outcome = call(&first, Request::ConnectionIdentity);
    assert!(matches!(
        outcome,
        LogicOutcome::Reply(reply) if matches!(*reply, Reply::Hello(_))
    ));
    let _ = call(&first, Request::AgentList);
    let snapshot = first.snapshot().unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&snapshot).unwrap()["handledRequests"],
        2
    );

    let second = vm.instantiate(&component).unwrap();
    second.initialize(&boot_bytes()).unwrap();
    second.restore(&snapshot).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&second.snapshot().unwrap()).unwrap()
            ["handledRequests"],
        2
    );
    assert!(matches!(
        call(&second, Request::UpdateDownload),
        LogicOutcome::Error(_)
    ));
}

#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM built for wasm32-wasip1"]
fn real_application_single_file_hot_updates_without_restarting_runtime() {
    let component = application_component();
    let key = signing_key(7);
    let fallback = signed_component(&key, "embedded", component.clone());
    let packaged = fallback.to_single_file().unwrap();
    let decoded = SignedArtifact::from_single_file(&packaged).unwrap();
    assert_eq!(decoded.component, component);

    let directory = tempfile::tempdir().unwrap();
    let logs = directory.path().join("logs");
    fs::create_dir(&logs).unwrap();
    let runtime = PlatformRuntime::open_application(
        directory.path(),
        verifier(&key, 16 * 1024 * 1024),
        application_policy(&logs),
        fallback,
        boot_bytes(),
    )
    .unwrap();
    assert!(matches!(
        runtime_call(&runtime, Request::ConnectionIdentity),
        LogicOutcome::Reply(reply) if matches!(*reply, Reply::Hello(_))
    ));
    let before = runtime.active().unwrap();

    let installed = runtime
        .install(signed_component(&key, "next", component))
        .unwrap();
    assert_eq!(installed.generation, before.generation + 1);
    assert_eq!(installed.version, "next");
    assert!(matches!(
        runtime_call(&runtime, Request::AgentList),
        LogicOutcome::Error(_)
    ));

    let rolled_back = runtime.rollback().unwrap();
    assert_eq!(rolled_back.version, "embedded");
    assert!(matches!(
        runtime_call(&runtime, Request::UpdateCheck),
        LogicOutcome::Error(_)
    ));
}

fn application_path() -> PathBuf {
    std::env::var_os("GENET_DAEMON_LOGIC_WASM")
        .map(PathBuf::from)
        .expect("GENET_DAEMON_LOGIC_WASM must name the real Rust guest")
}

fn application_policy(logs: &std::path::Path) -> VmPolicy {
    VmPolicy::application(LOGIC_ABI_VERSION)
        .with_wasi_preopen(logs, "/genehub-logs", false)
        .with_capability_handler(|_: &[u8]| {
            Err("this lifecycle test does not exercise system capabilities".to_string())
        })
}

/// CI hands every OS the signed single-file distribution artifact. Local
/// development may point at the raw compiler output, so accept both without
/// changing the VM contract (the VM always receives core Wasm bytes).
fn application_component() -> Vec<u8> {
    let bytes = fs::read(application_path()).unwrap();
    SignedArtifact::from_single_file(&bytes)
        .map(|artifact| artifact.component)
        .unwrap_or(bytes)
}

fn boot_bytes() -> Vec<u8> {
    encode_message(
        "logic boot",
        &LogicBoot {
            daemon_version: "1.2.3".to_string(),
            protocol_version: PROTOCOL_VERSION,
            machine_id: "machine".to_string(),
            fingerprint: "fingerprint".to_string(),
            machine_name: "workstation".to_string(),
            rtc_supported: true,
            log_directory: "/genehub-logs".to_string(),
            log_display_directory: "/host/logs".to_string(),
            default_workspace: None,
            home_directory: None,
            builtin_agent_binary: None,
        },
    )
    .unwrap()
}

fn request(request: Request) -> Vec<u8> {
    encode_message(
        "logic input",
        &LogicInput::Request(LogicRequest {
            call_id: 7,
            transport: TransportKind::Loopback,
            request,
        }),
    )
    .unwrap()
}

fn call(instance: &genet_daemon_platform::LogicInstance, request_value: Request) -> LogicOutcome {
    let output = instance.handle(&request(request_value)).unwrap();
    decode_message::<Result<LogicOutput, String>>("logic output", &output, 4 * 1024 * 1024)
        .unwrap()
        .unwrap()
        .completions
        .pop()
        .unwrap()
        .outcome
}

fn runtime_call(runtime: &PlatformRuntime, request_value: Request) -> LogicOutcome {
    let output = runtime.handle(&request(request_value)).unwrap();
    decode_message::<Result<LogicOutput, String>>("logic output", &output, 4 * 1024 * 1024)
        .unwrap()
        .unwrap()
        .completions
        .pop()
        .unwrap()
        .outcome
}
