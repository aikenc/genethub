mod support;

use genet_daemon_platform::{LogicVm, PlatformError, VmLimits, VmPolicy};
use support::{component, healthy_component, ComponentSpec};

#[test]
fn real_core_wasm_module_loads_and_calls_through_typed_contract() {
    let vm = LogicVm::new(VmPolicy::new(1)).unwrap();
    let first = vm.instantiate(&healthy_component(1)).unwrap();
    let second = vm.instantiate(&healthy_component(10)).unwrap();

    assert_eq!(first.probe(41).unwrap(), 42);
    assert_eq!(second.probe(41).unwrap(), 51);
    assert_eq!(first.probe(-2).unwrap(), -1);
}

#[test]
fn malformed_missing_importing_and_incompatible_modules_are_rejected() {
    let vm = LogicVm::new(VmPolicy::new(1)).unwrap();

    assert!(matches!(
        vm.instantiate(b"not wasm"),
        Err(PlatformError::Vm(_))
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            abi: 2,
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("reports ABI 2")
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            include_probe: false,
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("genehub-probe")
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            module_import: "(import \"forbidden\" \"call\" (func $forbidden))".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("unexpected imports: forbidden")
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            probe_signature: "(param i32) (result i32)".to_string(),
            probe_body: "local.get 0".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(_))
    ));
}

#[test]
fn self_check_traps_and_bad_health_are_rejected_before_activation() {
    let mut policy = VmPolicy::new(1);
    policy.limits.fuel_per_call = 10_000;
    let vm = LogicVm::new(policy).unwrap();

    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            self_check_body: "unreachable".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("genehub-self-check")
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            self_check_body: "i32.const 0".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("returned 0")
    ));
    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            self_check_body: "(loop $forever br $forever) i32.const 1".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("fuel")
            || message.contains("genehub-self-check")
    ));
}

#[test]
fn fuel_and_memory_limits_trap_and_poison_the_instance() {
    let mut policy = VmPolicy::new(1);
    policy.limits = VmLimits {
        max_memory_bytes: 64 * 1024,
        fuel_per_call: 10_000,
        ..VmLimits::default()
    };
    let vm = LogicVm::new(policy).unwrap();

    assert!(matches!(
        vm.instantiate(&component(ComponentSpec {
            core_prelude: "(memory 2)".to_string(),
            ..ComponentSpec::default()
        })),
        Err(PlatformError::Vm(message)) if message.contains("memory")
            || message.contains("limit")
    ));

    let grower = vm
        .instantiate(&component(ComponentSpec {
            core_prelude: "(memory 1)".to_string(),
            probe_body: "i32.const 1 memory.grow drop local.get 0".to_string(),
            ..ComponentSpec::default()
        }))
        .unwrap();
    assert!(matches!(grower.probe(1), Err(PlatformError::Vm(_))));
    assert!(matches!(
        grower.probe(1),
        Err(PlatformError::InstancePoisoned)
    ));

    let spinner = vm
        .instantiate(&component(ComponentSpec {
            probe_body: "(loop $forever br $forever) local.get 0".to_string(),
            ..ComponentSpec::default()
        }))
        .unwrap();
    assert!(matches!(spinner.probe(1), Err(PlatformError::Vm(_))));
    assert!(matches!(
        spinner.probe(1),
        Err(PlatformError::InstancePoisoned)
    ));
}

#[test]
fn initialization_is_fuel_limited_before_guest_code_can_become_active() {
    let mut policy = VmPolicy::new(1);
    policy.limits.fuel_per_call = 10_000;
    let vm = LogicVm::new(policy).unwrap();
    let result = vm.instantiate(&component(ComponentSpec {
        core_prelude: "(func $start (loop $forever br $forever)) (start $start)".to_string(),
        ..ComponentSpec::default()
    }));

    assert!(
        matches!(result, Err(PlatformError::Vm(message)) if message.contains("fuel")
            || message.contains("instantiating"))
    );
}

#[test]
fn zero_resource_limits_are_rejected_at_engine_construction() {
    for clear_limit in 0..7 {
        let mut policy = VmPolicy::new(1);
        match clear_limit {
            0 => policy.limits.max_memory_bytes = 0,
            1 => policy.limits.max_table_elements = 0,
            2 => policy.limits.max_instances = 0,
            3 => policy.limits.max_memories = 0,
            4 => policy.limits.max_tables = 0,
            5 => policy.limits.max_wasm_stack_bytes = 0,
            6 => policy.limits.fuel_per_call = 0,
            _ => unreachable!(),
        }
        assert!(matches!(LogicVm::new(policy), Err(PlatformError::Vm(_))));
    }
}
