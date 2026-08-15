//! The portable GeneHub daemon application.
//!
//! This crate is ordinary Rust and is tested natively, then compiled once on
//! Linux to `wasm32-wasip1`. The platform grants only explicit WASI
//! capabilities; there is no inherited environment, stdio, network or ambient
//! filesystem. The exported ABI moves whole serialized events and command
//! batches so strings and request trees cross the VM boundary once.

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use std::sync::{Mutex, OnceLock};

    use genet_daemon_common::{decode_json, encode_json};
    use genet_daemon_core::LogicApp;
    use genet_daemon_logic_api::{LogicBoot, LogicInput, LogicOutput};

    const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

    #[derive(Default)]
    struct Runtime {
        app: Option<LogicApp>,
        output: Vec<u8>,
    }

    static RUNTIME: OnceLock<Mutex<Runtime>> = OnceLock::new();

    fn runtime() -> &'static Mutex<Runtime> {
        RUNTIME.get_or_init(|| Mutex::new(Runtime::default()))
    }

    #[export_name = "genehub-abi-version"]
    pub extern "C" fn genehub_abi_version() -> i32 {
        genet_daemon_logic_api::ABI_VERSION as i32
    }

    #[export_name = "genehub-self-check"]
    pub extern "C" fn genehub_self_check() -> i32 {
        1
    }

    #[export_name = "genehub-probe"]
    pub extern "C" fn genehub_probe(input: i64) -> i64 {
        input.saturating_add(77)
    }

    /// Allocates a fixed-size input block. The host transfers ownership by
    /// calling one of the consuming exports below exactly once.
    #[no_mangle]
    pub extern "C" fn genehub_alloc(length: i32) -> i32 {
        let Ok(length) = usize::try_from(length) else {
            return 0;
        };
        if length == 0 || length > MAX_INPUT_BYTES {
            return 0;
        }
        let block = vec![0_u8; length].into_boxed_slice();
        Box::into_raw(block) as *mut u8 as i32
    }

    #[no_mangle]
    pub unsafe extern "C" fn genehub_initialize(pointer: i32, length: i32) -> i64 {
        consume_input(pointer, length, |input, runtime| {
            let boot: LogicBoot = decode_json("logic boot", input, MAX_INPUT_BYTES)?;
            runtime.app = Some(LogicApp::new(boot)?);
            encode_json("initialize result", &Result::<(), String>::Ok(()))
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn genehub_handle(pointer: i32, length: i32) -> i64 {
        consume_input(pointer, length, |input, runtime| {
            let event: LogicInput = decode_json("logic input", input, MAX_INPUT_BYTES)?;
            let app = runtime
                .app
                .as_mut()
                .ok_or_else(|| "logic is not initialized".to_string())?;
            encode_json(
                "logic output",
                &Result::<LogicOutput, String>::Ok(app.handle(event)),
            )
        })
    }

    #[no_mangle]
    pub extern "C" fn genehub_snapshot() -> i64 {
        with_runtime(|runtime| {
            runtime
                .app
                .as_ref()
                .ok_or_else(|| "logic is not initialized".to_string())?
                .snapshot()
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn genehub_restore(pointer: i32, length: i32) -> i64 {
        consume_input(pointer, length, |input, runtime| {
            runtime.app = Some(LogicApp::restore(input)?);
            encode_json("restore result", &Result::<(), String>::Ok(()))
        })
    }

    unsafe fn consume_input(
        pointer: i32,
        length: i32,
        operation: impl FnOnce(&[u8], &mut Runtime) -> Result<Vec<u8>, String>,
    ) -> i64 {
        let Ok(length) = usize::try_from(length) else {
            return store_error("negative input length");
        };
        if pointer == 0 || length == 0 || length > MAX_INPUT_BYTES {
            return store_error("invalid input buffer");
        }
        let slice = std::ptr::slice_from_raw_parts_mut(pointer as *mut u8, length);
        // SAFETY: `genehub_alloc` created this exact boxed slice and the ABI
        // transfers it to exactly one consuming call.
        let input = unsafe { Box::from_raw(slice) };
        let mut runtime = runtime().lock().expect("logic runtime lock");
        match operation(&input, &mut runtime) {
            Ok(output) => store_output(&mut runtime, output),
            Err(error) => {
                let output = encode_json("logic error", &Result::<(), String>::Err(error))
                    .unwrap_or_else(|_| b"{\"Err\":\"logic failure\"}".to_vec());
                store_output(&mut runtime, output)
            }
        }
    }

    fn with_runtime(operation: impl FnOnce(&mut Runtime) -> Result<Vec<u8>, String>) -> i64 {
        let mut runtime = runtime().lock().expect("logic runtime lock");
        match operation(&mut runtime) {
            Ok(output) => store_output(&mut runtime, output),
            Err(error) => {
                let output = encode_json("logic error", &Result::<(), String>::Err(error))
                    .unwrap_or_else(|_| b"{\"Err\":\"logic failure\"}".to_vec());
                store_output(&mut runtime, output)
            }
        }
    }

    fn store_error(message: &str) -> i64 {
        with_runtime(|_| {
            encode_json(
                "logic error",
                &Result::<(), String>::Err(message.to_string()),
            )
        })
    }

    fn store_output(runtime: &mut Runtime, output: Vec<u8>) -> i64 {
        runtime.output = output;
        let pointer = runtime.output.as_ptr() as usize as u64;
        let length = runtime.output.len() as u64;
        ((pointer << 32) | length) as i64
    }
}
