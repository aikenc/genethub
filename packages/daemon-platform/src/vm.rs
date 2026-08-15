use std::sync::Mutex;

use wasmtime::{Config, Engine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder, TypedFunc};

use crate::error::{PlatformError, Result};

const ABI_VERSION_EXPORT: &str = "genehub-abi-version";
const SELF_CHECK_EXPORT: &str = "genehub-self-check";
const PROBE_EXPORT: &str = "genehub-probe";

#[derive(Clone, Debug)]
pub struct VmLimits {
    pub max_memory_bytes: usize,
    pub max_table_elements: usize,
    pub max_instances: usize,
    pub max_memories: usize,
    pub max_tables: usize,
    pub max_wasm_stack_bytes: usize,
    pub fuel_per_call: u64,
}

impl Default for VmLimits {
    fn default() -> Self {
        Self {
            max_memory_bytes: 64 * 1024 * 1024,
            max_table_elements: 16 * 1024,
            max_instances: 64,
            max_memories: 8,
            max_tables: 8,
            max_wasm_stack_bytes: 2 * 1024 * 1024,
            fuel_per_call: 5_000_000,
        }
    }
}

#[derive(Clone, Debug)]
pub struct VmPolicy {
    pub abi_version: u32,
    pub limits: VmLimits,
}

impl VmPolicy {
    pub fn new(abi_version: u32) -> Self {
        Self {
            abi_version,
            limits: VmLimits::default(),
        }
    }
}

#[derive(Clone)]
pub struct LogicVm {
    engine: Engine,
    policy: VmPolicy,
}

impl LogicVm {
    pub fn new(policy: VmPolicy) -> Result<Self> {
        validate_limits(&policy.limits)?;
        let mut config = Config::new();
        config
            .consume_fuel(true)
            .max_wasm_stack(policy.limits.max_wasm_stack_bytes);
        let engine = Engine::new(&config)
            .map_err(|error| PlatformError::Vm(format!("creating engine: {error:#}")))?;
        Ok(Self { engine, policy })
    }

    /// Compiles and instantiates a self-contained core Wasm module, then executes its
    /// ABI and health exports before it can become active.
    pub fn instantiate(&self, module_bytes: &[u8]) -> Result<LogicInstance> {
        let module = Module::from_binary(&self.engine, module_bytes)
            .map_err(|error| PlatformError::Vm(format!("compiling module: {error:#}")))?;
        let imports = module
            .imports()
            .map(|import| format!("{}::{}", import.module(), import.name()))
            .collect::<Vec<_>>();
        if !imports.is_empty() {
            return Err(PlatformError::Vm(format!(
                "foundation logic modules must be self-contained; unexpected imports: {}",
                imports.join(", ")
            )));
        }

        let mut store = Store::new(
            &self.engine,
            StoreState {
                limits: build_store_limits(&self.policy.limits),
            },
        );
        store.limiter(|state| &mut state.limits);
        reset_fuel(&mut store, self.policy.limits.fuel_per_call)?;
        let instance = Linker::new(&self.engine)
            .instantiate(&mut store, &module)
            .map_err(|error| PlatformError::Vm(format!("instantiating module: {error:#}")))?;

        let abi_version = instance
            .get_typed_func::<(), i32>(&mut store, ABI_VERSION_EXPORT)
            .map_err(|error| {
                PlatformError::Vm(format!(
                    "missing or invalid {ABI_VERSION_EXPORT} export: {error:#}"
                ))
            })?;
        let self_check = instance
            .get_typed_func::<(), i32>(&mut store, SELF_CHECK_EXPORT)
            .map_err(|error| {
                PlatformError::Vm(format!(
                    "missing or invalid {SELF_CHECK_EXPORT} export: {error:#}"
                ))
            })?;
        let probe = instance
            .get_typed_func::<i64, i64>(&mut store, PROBE_EXPORT)
            .map_err(|error| {
                PlatformError::Vm(format!(
                    "missing or invalid {PROBE_EXPORT} export: {error:#}"
                ))
            })?;

        reset_fuel(&mut store, self.policy.limits.fuel_per_call)?;
        let reported_abi = abi_version.call(&mut store, ()).map_err(|error| {
            PlatformError::Vm(format!("calling {ABI_VERSION_EXPORT}: {error:#}"))
        })?;
        if reported_abi < 0 || reported_abi as u32 != self.policy.abi_version {
            return Err(PlatformError::Vm(format!(
                "module reports ABI {reported_abi}, platform requires {}",
                self.policy.abi_version
            )));
        }

        reset_fuel(&mut store, self.policy.limits.fuel_per_call)?;
        let healthy = self_check.call(&mut store, ()).map_err(|error| {
            PlatformError::Vm(format!("calling {SELF_CHECK_EXPORT}: {error:#}"))
        })?;
        if healthy != 1 {
            return Err(PlatformError::Vm(format!(
                "module self-check returned {healthy}, expected 1"
            )));
        }

        Ok(LogicInstance {
            fuel_per_call: self.policy.limits.fuel_per_call,
            inner: Mutex::new(InstanceState {
                store,
                probe,
                poisoned: false,
            }),
        })
    }
}

/// One stateful logic instance. Calls are serialized because a Wasmtime Store
/// is single-owner; a trap permanently poisons this instance for callers.
pub struct LogicInstance {
    fuel_per_call: u64,
    inner: Mutex<InstanceState>,
}

impl LogicInstance {
    pub fn probe(&self, input: i64) -> Result<i64> {
        let mut inner = self.inner.lock().map_err(|_| PlatformError::LockPoisoned)?;
        if inner.poisoned {
            return Err(PlatformError::InstancePoisoned);
        }
        if let Err(error) = reset_fuel(&mut inner.store, self.fuel_per_call) {
            inner.poisoned = true;
            return Err(error);
        }
        let probe = inner.probe.clone();
        match probe.call(&mut inner.store, input) {
            Ok(output) => Ok(output),
            Err(error) => {
                inner.poisoned = true;
                Err(PlatformError::Vm(format!(
                    "calling {PROBE_EXPORT}: {error:#}"
                )))
            }
        }
    }
}

struct StoreState {
    limits: StoreLimits,
}

struct InstanceState {
    store: Store<StoreState>,
    probe: TypedFunc<i64, i64>,
    poisoned: bool,
}

fn build_store_limits(limits: &VmLimits) -> StoreLimits {
    StoreLimitsBuilder::new()
        .memory_size(limits.max_memory_bytes)
        .table_elements(limits.max_table_elements)
        .instances(limits.max_instances)
        .memories(limits.max_memories)
        .tables(limits.max_tables)
        .trap_on_grow_failure(true)
        .build()
}

fn reset_fuel(store: &mut Store<StoreState>, fuel: u64) -> Result<()> {
    store
        .set_fuel(fuel)
        .map_err(|error| PlatformError::Vm(format!("setting execution fuel: {error:#}")))
}

fn validate_limits(limits: &VmLimits) -> Result<()> {
    if limits.max_memory_bytes == 0
        || limits.max_table_elements == 0
        || limits.max_instances == 0
        || limits.max_memories == 0
        || limits.max_tables == 0
        || limits.max_wasm_stack_bytes == 0
        || limits.fuel_per_call == 0
    {
        return Err(PlatformError::Vm(
            "all VM resource limits must be positive".to_string(),
        ));
    }
    Ok(())
}
