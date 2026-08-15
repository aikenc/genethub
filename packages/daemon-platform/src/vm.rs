use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sha2::{Digest, Sha256};
use wasmtime::{
    Config, Engine, Linker, Memory, Module, Store, StoreLimits, StoreLimitsBuilder, Strategy,
    TypedFunc,
};

use crate::error::{PlatformError, Result};

const ABI_VERSION_EXPORT: &str = "genehub-abi-version";
const SELF_CHECK_EXPORT: &str = "genehub-self-check";
const PROBE_EXPORT: &str = "genehub-probe";
const MEMORY_EXPORT: &str = "memory";
const ALLOC_EXPORT: &str = "genehub_alloc";
const INITIALIZE_EXPORT: &str = "genehub_initialize";
const HANDLE_EXPORT: &str = "genehub_handle";
const SNAPSHOT_EXPORT: &str = "genehub_snapshot";
const RESTORE_EXPORT: &str = "genehub_restore";

#[derive(Clone, Debug)]
pub struct VmLimits {
    pub max_memory_bytes: usize,
    pub max_table_elements: usize,
    pub max_instances: usize,
    pub max_memories: usize,
    pub max_tables: usize,
    pub max_wasm_stack_bytes: usize,
    pub fuel_per_call: u64,
    pub max_message_bytes: usize,
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
            max_message_bytes: 4 * 1024 * 1024,
        }
    }
}

#[derive(Clone, Debug)]
pub struct VmPolicy {
    pub abi_version: u32,
    pub limits: VmLimits,
    pub require_application_abi: bool,
}

impl VmPolicy {
    pub fn new(abi_version: u32) -> Self {
        Self {
            abi_version,
            limits: VmLimits::default(),
            require_application_abi: false,
        }
    }

    pub fn application(abi_version: u32) -> Self {
        Self {
            abi_version,
            limits: VmLimits::default(),
            require_application_abi: true,
        }
    }
}

#[derive(Clone)]
pub struct LogicVm {
    engine: Engine,
    policy: VmPolicy,
    modules: Arc<Mutex<HashMap<[u8; 32], Module>>>,
}

impl LogicVm {
    pub fn new(policy: VmPolicy) -> Result<Self> {
        validate_limits(&policy.limits)?;
        let mut config = Config::new();
        config
            // Daemon logic favors startup/update latency over peak throughput.
            // Winch compiles Rust Wasm in a fraction of Cranelift's time and
            // supports every x64/arm64 desktop target in the release matrix.
            .strategy(Strategy::Winch)
            .consume_fuel(true)
            .max_wasm_stack(policy.limits.max_wasm_stack_bytes);
        let engine = Engine::new(&config)
            .map_err(|error| PlatformError::Vm(format!("creating engine: {error:#}")))?;
        Ok(Self {
            engine,
            policy,
            modules: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// Compiles and instantiates a self-contained core Wasm module, then executes its
    /// ABI and health exports before it can become active.
    pub fn instantiate(&self, module_bytes: &[u8]) -> Result<LogicInstance> {
        let digest: [u8; 32] = Sha256::digest(module_bytes).into();
        // Keep the guard in its own scope. An `if let` scrutinee temporary can
        // otherwise live through the `else`, where a cache miss takes the same
        // non-reentrant mutex again.
        let cached = {
            self.modules
                .lock()
                .map_err(|_| PlatformError::LockPoisoned)?
                .get(&digest)
                .cloned()
        };
        let module = if let Some(module) = cached {
            module
        } else {
            let compiled = Module::from_binary(&self.engine, module_bytes)
                .map_err(|error| PlatformError::Vm(format!("compiling module: {error:#}")))?;
            self.modules
                .lock()
                .map_err(|_| PlatformError::LockPoisoned)?
                .entry(digest)
                .or_insert_with(|| compiled.clone())
                .clone()
        };
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

        let application = if self.policy.require_application_abi {
            Some(ApplicationExports {
                memory: instance
                    .get_memory(&mut store, MEMORY_EXPORT)
                    .ok_or_else(|| PlatformError::Vm(format!("missing {MEMORY_EXPORT} export")))?,
                alloc: instance
                    .get_typed_func::<i32, i32>(&mut store, ALLOC_EXPORT)
                    .map_err(|error| {
                        PlatformError::Vm(format!(
                            "missing or invalid {ALLOC_EXPORT} export: {error:#}"
                        ))
                    })?,
                initialize: instance
                    .get_typed_func::<(i32, i32), i64>(&mut store, INITIALIZE_EXPORT)
                    .map_err(|error| {
                        PlatformError::Vm(format!(
                            "missing or invalid {INITIALIZE_EXPORT} export: {error:#}"
                        ))
                    })?,
                handle: instance
                    .get_typed_func::<(i32, i32), i64>(&mut store, HANDLE_EXPORT)
                    .map_err(|error| {
                        PlatformError::Vm(format!(
                            "missing or invalid {HANDLE_EXPORT} export: {error:#}"
                        ))
                    })?,
                snapshot: instance
                    .get_typed_func::<(), i64>(&mut store, SNAPSHOT_EXPORT)
                    .map_err(|error| {
                        PlatformError::Vm(format!(
                            "missing or invalid {SNAPSHOT_EXPORT} export: {error:#}"
                        ))
                    })?,
                restore: instance
                    .get_typed_func::<(i32, i32), i64>(&mut store, RESTORE_EXPORT)
                    .map_err(|error| {
                        PlatformError::Vm(format!(
                            "missing or invalid {RESTORE_EXPORT} export: {error:#}"
                        ))
                    })?,
            })
        } else {
            None
        };

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
            max_message_bytes: self.policy.limits.max_message_bytes,
            inner: Mutex::new(InstanceState {
                store,
                probe,
                self_check,
                application,
                poisoned: false,
            }),
        })
    }
}

/// One stateful logic instance. Calls are serialized because a Wasmtime Store
/// is single-owner; a trap permanently poisons this instance for callers.
pub struct LogicInstance {
    fuel_per_call: u64,
    max_message_bytes: usize,
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

    pub fn initialize(&self, boot: &[u8]) -> Result<()> {
        let output = self.call_with_input(INITIALIZE_EXPORT, boot, |application| {
            application.initialize.clone()
        })?;
        decode_unit_result(INITIALIZE_EXPORT, &output)
    }

    /// Sends one complete application event and returns one complete result
    /// buffer. The platform never interprets strings or domain fields.
    pub fn handle(&self, event: &[u8]) -> Result<Vec<u8>> {
        self.call_with_input(HANDLE_EXPORT, event, |application| {
            application.handle.clone()
        })
    }

    /// Returns opaque guest-owned state for side-by-side replacement.
    pub fn snapshot(&self) -> Result<Vec<u8>> {
        let mut inner = self.inner.lock().map_err(|_| PlatformError::LockPoisoned)?;
        if inner.poisoned {
            return Err(PlatformError::InstancePoisoned);
        }
        let Some(application) = inner.application.clone() else {
            return Err(PlatformError::Vm(
                "logic instance has no application ABI".to_string(),
            ));
        };
        if let Err(error) = reset_fuel(&mut inner.store, self.fuel_per_call) {
            inner.poisoned = true;
            return Err(error);
        }
        let packed = match application.snapshot.call(&mut inner.store, ()) {
            Ok(packed) => packed,
            Err(error) => {
                inner.poisoned = true;
                return Err(PlatformError::Vm(format!(
                    "calling {SNAPSHOT_EXPORT}: {error:#}"
                )));
            }
        };
        let output = read_guest_output(
            &application.memory,
            &mut inner.store,
            packed,
            self.max_message_bytes,
            SNAPSHOT_EXPORT,
        );
        if output.is_err() {
            inner.poisoned = true;
        }
        output
    }

    pub fn restore(&self, snapshot: &[u8]) -> Result<()> {
        let output = self.call_with_input(RESTORE_EXPORT, snapshot, |application| {
            application.restore.clone()
        })?;
        decode_unit_result(RESTORE_EXPORT, &output)
    }

    pub fn health_check(&self) -> Result<()> {
        let mut inner = self.inner.lock().map_err(|_| PlatformError::LockPoisoned)?;
        if inner.poisoned {
            return Err(PlatformError::InstancePoisoned);
        }
        if let Err(error) = reset_fuel(&mut inner.store, self.fuel_per_call) {
            inner.poisoned = true;
            return Err(error);
        }
        let self_check = inner.self_check.clone();
        let healthy = match self_check.call(&mut inner.store, ()) {
            Ok(healthy) => healthy,
            Err(error) => {
                inner.poisoned = true;
                return Err(PlatformError::Vm(format!(
                    "calling {SELF_CHECK_EXPORT}: {error:#}"
                )));
            }
        };
        if healthy != 1 {
            inner.poisoned = true;
            return Err(PlatformError::Vm(format!(
                "module self-check returned {healthy}, expected 1"
            )));
        }
        Ok(())
    }

    fn call_with_input(
        &self,
        export: &str,
        input: &[u8],
        function: impl FnOnce(&ApplicationExports) -> TypedFunc<(i32, i32), i64>,
    ) -> Result<Vec<u8>> {
        if input.is_empty() || input.len() > self.max_message_bytes {
            return Err(PlatformError::Vm(format!(
                "{export} input is {} bytes, expected 1 through {}",
                input.len(),
                self.max_message_bytes
            )));
        }
        let input_len = i32::try_from(input.len())
            .map_err(|_| PlatformError::Vm(format!("{export} input is too large")))?;
        let mut inner = self.inner.lock().map_err(|_| PlatformError::LockPoisoned)?;
        if inner.poisoned {
            return Err(PlatformError::InstancePoisoned);
        }
        let Some(application) = inner.application.clone() else {
            return Err(PlatformError::Vm(
                "logic instance has no application ABI".to_string(),
            ));
        };
        if let Err(error) = reset_fuel(&mut inner.store, self.fuel_per_call) {
            inner.poisoned = true;
            return Err(error);
        }
        let pointer = match application.alloc.call(&mut inner.store, input_len) {
            Ok(pointer) if pointer > 0 => pointer,
            Ok(_) => {
                inner.poisoned = true;
                return Err(PlatformError::Vm(format!(
                    "{ALLOC_EXPORT} rejected {input_len} bytes"
                )));
            }
            Err(error) => {
                inner.poisoned = true;
                return Err(PlatformError::Vm(format!(
                    "calling {ALLOC_EXPORT} for {export}: {error:#}"
                )));
            }
        };
        if let Err(error) = application
            .memory
            .write(&mut inner.store, pointer as usize, input)
        {
            inner.poisoned = true;
            return Err(PlatformError::Vm(format!(
                "writing {export} input into guest memory: {error:#}"
            )));
        }
        let function = function(&application);
        let packed = match function.call(&mut inner.store, (pointer, input_len)) {
            Ok(packed) => packed,
            Err(error) => {
                inner.poisoned = true;
                return Err(PlatformError::Vm(format!("calling {export}: {error:#}")));
            }
        };
        let output = read_guest_output(
            &application.memory,
            &mut inner.store,
            packed,
            self.max_message_bytes,
            export,
        );
        if output.is_err() {
            inner.poisoned = true;
        }
        output
    }
}

struct StoreState {
    limits: StoreLimits,
}

struct InstanceState {
    store: Store<StoreState>,
    probe: TypedFunc<i64, i64>,
    self_check: TypedFunc<(), i32>,
    application: Option<ApplicationExports>,
    poisoned: bool,
}

#[derive(Clone)]
struct ApplicationExports {
    memory: Memory,
    alloc: TypedFunc<i32, i32>,
    initialize: TypedFunc<(i32, i32), i64>,
    handle: TypedFunc<(i32, i32), i64>,
    snapshot: TypedFunc<(), i64>,
    restore: TypedFunc<(i32, i32), i64>,
}

fn read_guest_output(
    memory: &Memory,
    store: &mut Store<StoreState>,
    packed: i64,
    max_message_bytes: usize,
    export: &str,
) -> Result<Vec<u8>> {
    let packed = packed as u64;
    let pointer = (packed >> 32) as u32 as usize;
    let length = (packed & u32::MAX as u64) as u32 as usize;
    if pointer == 0 || length == 0 || length > max_message_bytes {
        return Err(PlatformError::Vm(format!(
            "{export} returned invalid buffer ({pointer}, {length})"
        )));
    }
    let mut output = vec![0_u8; length];
    memory.read(store, pointer, &mut output).map_err(|error| {
        PlatformError::Vm(format!(
            "reading {export} output from guest memory: {error:#}"
        ))
    })?;
    Ok(output)
}

fn decode_unit_result(export: &str, output: &[u8]) -> Result<()> {
    let result: std::result::Result<(), String> =
        serde_json::from_slice(output).map_err(|error| {
            PlatformError::Vm(format!("decoding {export} lifecycle result: {error}"))
        })?;
    result.map_err(|message| PlatformError::Vm(format!("{export} rejected state: {message}")))
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
        || limits.max_message_bytes == 0
    {
        return Err(PlatformError::Vm(
            "all VM resource limits must be positive".to_string(),
        ));
    }
    Ok(())
}
