//! Process spawn types.
//!
//! Native is `tokio::process`. The guest gets the same shape backed by the
//! host's `process` WIT import, because WASI has no exec (WASI#899).

#[cfg(not(target_family = "wasm"))]
pub use std::process::Output;
#[cfg(not(target_family = "wasm"))]
pub use tokio::process::Command;

#[cfg(target_family = "wasm")]
pub use genet_wasi::process::{Command, Output};
