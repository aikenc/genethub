//! Process spawn types shared by native tools and the host-backed WASI guest.

#[cfg(target_family = "wasm")]
pub use genet_wasi::process::{Child, Command};
#[cfg(not(target_family = "wasm"))]
pub use tokio::process::{Child, Command};
