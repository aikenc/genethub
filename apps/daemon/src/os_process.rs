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

/// A directory that exists and belongs to no project: where to start a child
/// whose working directory would otherwise say something about the user's work.
///
/// The guest asks the shell rather than answering for itself, because the child
/// is started by the shell and it is the shell's idea of "temp" that the child
/// will see. `std::env::temp_dir` is not an option there at all — it aborts the
/// instance on `wasm32-wasip2`.
#[cfg(not(target_family = "wasm"))]
pub fn scratch_dir() -> std::path::PathBuf {
    std::env::temp_dir()
}

#[cfg(target_family = "wasm")]
pub fn scratch_dir() -> std::path::PathBuf {
    genet_wasi::wit::genehub::host::process::scratch_dir().into()
}
