//! Standard input and output.
//!
//! `tokio::io::stdin` hands the descriptor to a blocking thread, which this
//! target does not have. WASI exposes stdio as ordinary non-blocking streams
//! instead, so the guest reads and writes them the same way it reads a pipe.

#[cfg(not(target_family = "wasm"))]
pub use tokio::io::{stdin, stdout};

#[cfg(target_family = "wasm")]
pub use genet_wasi::stdio::{stdin, stdout};
