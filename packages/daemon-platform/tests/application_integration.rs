mod support;

use std::fs;
use std::path::PathBuf;

use genehub_proto::{Reply, Request, TransportKind, PROTOCOL_VERSION};
use genet_daemon_logic_api::{
    decode_message, encode_message, CarrierInput, CarrierOutput, CarrierRequest, LogicBoot,
    LogicOutcome,
};
use genet_daemon_platform::{
    LogicVm, PlatformRuntime, SignedArtifact, VmPolicy, LOGIC_ABI_VERSION,
};
use support::{signed_component, signing_key, verifier};

#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM built for wasm32-wasip1"]
fn real_rust_application_is_stateful_only_within_one_cold_instance() {
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
    let second = vm.instantiate(&component).unwrap();
    second.initialize(&boot_bytes()).unwrap();
    // A cold replacement starts from durable product storage and boot facts;
    // transient in-memory request state is deliberately not transferred.
    assert!(matches!(
        call(&second, Request::ConnectionIdentity),
        LogicOutcome::Reply(reply) if matches!(*reply, Reply::Hello(_))
    ));
}

#[test]
#[ignore = "requires GENET_DAEMON_LOGIC_WASM built for wasm32-wasip1"]
fn real_application_single_file_cold_updates_without_state_transfer() {
    let component = application_component();
    let key = signing_key(7);
    let fallback = signed_component(&key, 1, component.clone());
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
        .install(signed_component(&key, 2, component))
        .unwrap();
    assert_eq!(before.revision, 1);
    assert_eq!(installed.revision, 2);
    assert!(matches!(
        runtime_call(&runtime, Request::AgentList),
        LogicOutcome::Error(_)
    ));

    assert!(matches!(
        runtime_call(&runtime, Request::ConnectionIdentity),
        LogicOutcome::Reply(reply) if matches!(*reply, Reply::Hello(_))
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
            features: Vec::new(),
            isolation: None,
            log_directory: "/genehub-logs".to_string(),
            log_display_directory: "/host/logs".to_string(),
            default_workspace: None,
            home_directory: None,
            builtin_agent_binary: None,
            builtin_agent_home_env: None,
        },
    )
    .unwrap()
}

fn request(request: Request) -> Vec<u8> {
    encode_message(
        "carrier input",
        &CarrierInput::Request(CarrierRequest {
            call_id: 7,
            transport: TransportKind::Loopback,
            caller: genet_daemon_logic_api::CallerContext::LocalUser,
            route: Default::default(),
            body: serde_json::to_vec(&request).unwrap(),
        }),
    )
    .unwrap()
}

fn call(instance: &genet_daemon_platform::LogicInstance, request_value: Request) -> LogicOutcome {
    let output = instance.handle(&request(request_value)).unwrap();
    outcome(output)
}

fn runtime_call(runtime: &PlatformRuntime, request_value: Request) -> LogicOutcome {
    let output = runtime.handle(&request(request_value)).unwrap();
    outcome(output)
}

fn outcome(output: Vec<u8>) -> LogicOutcome {
    let response =
        decode_message::<Result<CarrierOutput, String>>("carrier output", &output, 4 * 1024 * 1024)
            .unwrap()
            .unwrap()
            .completions
            .pop()
            .unwrap()
            .response;
    if let Some(error) = response.error {
        LogicOutcome::Error(serde_json::from_slice(&error).unwrap())
    } else {
        LogicOutcome::Reply(Box::new(serde_json::from_slice(&response.body).unwrap()))
    }
}
