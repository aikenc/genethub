//! Process spawn types.
//!
//! Native is `tokio::process`. The guest gets the same shape backed by the
//! host's `process` WIT import, because WASI has no exec (WASI#899).

#[cfg(not(target_family = "wasm"))]
pub use std::process::ExitStatus;
#[cfg(not(target_family = "wasm"))]
pub use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};

#[cfg(target_family = "wasm")]
pub use genet_wasi::process::*;
