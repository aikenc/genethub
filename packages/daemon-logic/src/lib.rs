//! The portable GeneHub daemon application.
//!
//! This crate is ordinary Rust and is tested natively, then compiled once on
//! Linux to `wasm32-wasip1`. The platform grants only explicit WASI
//! capabilities; there is no inherited environment, stdio, network or ambient
//! filesystem. The exported ABI moves whole serialized events and command
//! batches so strings and request trees cross the VM boundary once.

#[cfg(any(target_arch = "wasm32", test))]
use genet_daemon_common::{decode_json, encode_json};
#[cfg(any(target_arch = "wasm32", test))]
use genet_daemon_logic_api::{
    CarrierCompletion, CarrierInput, CarrierOutput, CarrierPublication, CarrierResponse,
    LogicInput, LogicOutcome, LogicOutput, LogicRequest, Publication, PublicationSecurity,
};

#[cfg(any(target_arch = "wasm32", test))]
const MAX_BUSINESS_BYTES: usize = 3 * 1024 * 1024;

#[cfg(any(target_arch = "wasm32", test))]
fn decode_carrier_input(input: CarrierInput) -> Result<LogicInput, CarrierOutput> {
    match input {
        CarrierInput::Request(request) => {
            let decoded = match decode_json("business request", &request.body, MAX_BUSINESS_BYTES) {
                Ok(decoded) => decoded,
                Err(message) => return Err(bad_request(request.call_id, message)),
            };
            Ok(LogicInput::Request(LogicRequest {
                call_id: request.call_id,
                transport: request.transport,
                caller: request.caller,
                route: request.route,
                request: decoded,
            }))
        }
        CarrierInput::Platform(call) => Ok(LogicInput::Platform(call)),
        CarrierInput::CapabilityResults(results) => Ok(LogicInput::CapabilityResults(results)),
        CarrierInput::CapabilityEvent(event) => Ok(LogicInput::CapabilityEvent(event)),
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn encode_carrier_output(output: LogicOutput) -> Result<CarrierOutput, String> {
    let completions = output
        .completions
        .into_iter()
        .map(|completion| {
            let response = match completion.outcome {
                LogicOutcome::Reply(reply) => CarrierResponse {
                    status: 200,
                    body: encode_json("business reply", &reply)?,
                    error: None,
                },
                LogicOutcome::Error(error) => CarrierResponse {
                    status: error_status(error.code),
                    body: Vec::new(),
                    error: Some(encode_json("business error", &error)?),
                },
            };
            Ok(CarrierCompletion {
                call_id: completion.call_id,
                response,
                connection: completion.connection,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let publications = output
        .publications
        .into_iter()
        .map(|publication| match publication {
            Publication::Session(event) => {
                let session_id = event.session_id.clone();
                Ok(CarrierPublication::Session {
                    session_id: session_id.clone(),
                    event: encode_json(
                        "session event frame",
                        &genehub_proto::ServerFrame::event(&session_id, event),
                    )?,
                })
            }
            Publication::Fanout(frame) => {
                let security = match &frame {
                    genehub_proto::ServerFrame::PtyOutput { .. }
                    | genehub_proto::ServerFrame::PtyClosed { .. } => PublicationSecurity::Pty,
                    genehub_proto::ServerFrame::BackgroundProcesses { .. } => {
                        PublicationSecurity::BackgroundProcesses
                    }
                    genehub_proto::ServerFrame::Event { .. }
                    | genehub_proto::ServerFrame::Desync { .. }
                    | genehub_proto::ServerFrame::Notice { .. } => PublicationSecurity::General,
                };
                Ok(CarrierPublication::Fanout {
                    security,
                    frame: encode_json("fanout frame", &frame)?,
                })
            }
            Publication::DeviceRevoked { device_id } => {
                Ok(CarrierPublication::DeviceRevoked { device_id })
            }
        })
        .collect::<Result<Vec<_>, String>>()?;

    Ok(CarrierOutput {
        completions,
        platform_completions: output.platform_completions,
        capability_batches: output.capability_batches,
        publications,
    })
}

#[cfg(any(target_arch = "wasm32", test))]
fn bad_request(call_id: u64, message: String) -> CarrierOutput {
    let error = genehub_proto::ProtocolError {
        code: genehub_proto::ErrorCode::BadRequest,
        message,
    };
    CarrierOutput {
        completions: vec![CarrierCompletion {
            call_id,
            response: CarrierResponse {
                status: 400,
                body: Vec::new(),
                error: Some(encode_json("business error", &error).unwrap_or_else(|_| {
                    br#"{"code":"badRequest","message":"invalid request"}"#.to_vec()
                })),
            },
            connection: genet_daemon_logic_api::ConnectionDirective::None,
        }],
        ..CarrierOutput::default()
    }
}

#[cfg(any(target_arch = "wasm32", test))]
fn error_status(code: genehub_proto::ErrorCode) -> u16 {
    use genehub_proto::ErrorCode;
    match code {
        ErrorCode::BadRequest => 400,
        ErrorCode::Unauthorized => 401,
        ErrorCode::Forbidden => 403,
        ErrorCode::NotFound => 404,
        ErrorCode::Conflict => 409,
        ErrorCode::Unsupported => 422,
        ErrorCode::ProtocolVersion => 426,
        ErrorCode::Internal => 500,
        ErrorCode::IsolationUnavailable => 501,
    }
}

#[cfg(test)]
mod tests {
    use genehub_proto::{Reply, ServerFrame};
    use genet_daemon_logic_api::{
        CallerContext, CarrierInput, CarrierPublication, CarrierRequest, LogicOutcome, LogicOutput,
        Publication, PublicationSecurity, RequestRoute,
    };

    use super::{decode_carrier_input, encode_carrier_output};

    fn request(body: &[u8]) -> CarrierInput {
        CarrierInput::Request(CarrierRequest {
            call_id: 7,
            transport: genehub_proto::TransportKind::Forwarded,
            caller: CallerContext::Channel,
            route: RequestRoute::default(),
            body: body.to_vec(),
        })
    }

    #[test]
    fn v3_request_bytes_are_decoded_only_inside_the_application() {
        let raw = br#"{"type":"connection.identity"}"#;
        let decoded = decode_carrier_input(request(raw)).unwrap();
        let genet_daemon_logic_api::LogicInput::Request(decoded) = decoded else {
            panic!("wrong carrier input")
        };
        assert!(matches!(
            decoded.request,
            genehub_proto::Request::ConnectionIdentity
        ));
    }

    #[test]
    fn unknown_future_business_bytes_reach_the_application_error_codec() {
        let raw = br#"{"type":"future.v4.operation","payload":{"kept":true}}"#;
        let output = decode_carrier_input(request(raw)).unwrap_err();
        assert_eq!(output.completions.len(), 1);
        let response = &output.completions[0].response;
        assert_eq!(response.status, 400);
        let error: genehub_proto::ProtocolError =
            serde_json::from_slice(response.error.as_deref().unwrap()).unwrap();
        assert_eq!(error.code, genehub_proto::ErrorCode::BadRequest);
    }

    #[test]
    fn reply_json_is_byte_identical_to_the_v3_codec() {
        let expected = serde_json::to_vec(&Reply::Ack).unwrap();
        let output = encode_carrier_output(LogicOutput::completed(
            9,
            LogicOutcome::Reply(Box::new(Reply::Ack)),
        ))
        .unwrap();
        assert_eq!(output.completions[0].response.body, expected);
    }

    #[test]
    fn event_security_is_classified_before_native_fanout() {
        let frame = ServerFrame::PtyClosed {
            pty_id: "pty_1".into(),
            exit_code: Some(0),
        };
        let output = encode_carrier_output(LogicOutput {
            publications: vec![Publication::Fanout(frame.clone())],
            ..LogicOutput::default()
        })
        .unwrap();
        assert!(matches!(
            output.publications.as_slice(),
            [CarrierPublication::Fanout {
                security: PublicationSecurity::Pty,
                frame: bytes,
            }] if *bytes == serde_json::to_vec(&frame).unwrap()
        ));
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm_abi {
    use std::sync::{Mutex, OnceLock};

    use genet_daemon_common::encode_json;
    use genet_daemon_core::{CapabilityExecutor, LogicApp};
    use genet_daemon_logic_api::{
        decode_message, encode_message, CapabilityBatch, CapabilityResults, CarrierInput,
        CarrierOutput, LogicBoot,
    };

    use super::{decode_carrier_input, encode_carrier_output};

    const MAX_INPUT_BYTES: usize = 4 * 1024 * 1024;

    #[derive(Default)]
    struct Runtime {
        app: Option<LogicApp>,
        output: Vec<u8>,
        capability_output: Vec<u8>,
    }

    struct ImportedCapabilities<'a> {
        output: &'a mut Vec<u8>,
    }

    impl CapabilityExecutor for ImportedCapabilities<'_> {
        fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String> {
            let input = encode_message("capability batch", &batch)?;
            if input.is_empty() || input.len() > MAX_INPUT_BYTES {
                return Err("capability batch exceeds the ABI message limit".to_string());
            }
            self.output.clear();
            self.output.resize(MAX_INPUT_BYTES, 0);
            // SAFETY: both slices remain allocated and exclusively borrowed for
            // the duration of the host call. The host may write at most the
            // advertised output capacity and returns the initialized length.
            let length = unsafe {
                genehub_capability(
                    input.as_ptr() as i32,
                    input.len() as i32,
                    self.output.as_mut_ptr() as i32,
                    self.output.len() as i32,
                )
            };
            if length <= 0 {
                return Err(format!(
                    "platform capability bridge failed with code {length}"
                ));
            }
            let length = length as usize;
            if length > self.output.len() {
                return Err("platform capability bridge returned an oversized result".to_string());
            }
            self.output.truncate(length);
            decode_message("capability results", self.output, MAX_INPUT_BYTES)
        }
    }

    #[link(wasm_import_module = "genehub_platform")]
    unsafe extern "C" {
        fn genehub_capability(
            input_pointer: i32,
            input_length: i32,
            output_pointer: i32,
            output_capacity: i32,
        ) -> i32;
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
            let boot: LogicBoot = decode_message("logic boot", input, MAX_INPUT_BYTES)?;
            runtime.app = Some(LogicApp::new(boot)?);
            encode_json("initialize result", &Result::<(), String>::Ok(()))
        })
    }

    #[no_mangle]
    pub unsafe extern "C" fn genehub_handle(pointer: i32, length: i32) -> i64 {
        consume_input(pointer, length, |input, runtime| {
            let event: CarrierInput = decode_message("logic input", input, MAX_INPUT_BYTES)?;
            let Runtime {
                app,
                capability_output,
                ..
            } = runtime;
            let app = app
                .as_mut()
                .ok_or_else(|| "logic is not initialized".to_string())?;
            let mut capabilities = ImportedCapabilities {
                output: capability_output,
            };
            let output = match decode_carrier_input(event) {
                Ok(event) => encode_carrier_output(app.handle_with(event, &mut capabilities))?,
                Err(output) => output,
            };
            encode_message("logic output", &Result::<CarrierOutput, String>::Ok(output))
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
