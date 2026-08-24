//! Emitting the stable machine-readable CLI answer from inside the guest.
//!
//! The shape is `genet_frontdoor::envelope`, shared with the native front door
//! so the two can never disagree about what an error looks like. What is *not*
//! shared is where the bytes go: a verb running here hands lines to the NDJSON
//! stream on `POST /cli`, while the same envelope printed by the CLI goes
//! straight to its own stdout. One sink for both would mean one of them
//! printing into the void.

pub use genet_frontdoor::envelope::{
    envelope, error_envelope, generic_error_envelope, CliFailure, CLI_SCHEMA,
};

pub fn succeed(kind: &str, data: serde_json::Value) -> i32 {
    super::emit_stdout(envelope(kind, data).to_string());
    super::EXIT_OK
}

pub fn fail(error: CliFailure) -> i32 {
    super::emit_stderr(format!("error: {}", error.message));
    super::emit_stdout(error_envelope(&error).to_string());
    error.exit
}
