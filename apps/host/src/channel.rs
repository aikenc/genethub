//! Build identity: `local` for a source tree, otherwise the release channel.
//!
//! Written wholesale by `scripts/channel.mjs` — edit that script, not this
//! file. The shell and the guest are separate crates that must agree on the
//! names things are handed over with, so the shell reads the same stamped
//! constants the guest's crates do.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `local` | `dev` | `beta` | `stable`.
pub const CHANNEL: &str = "local";
/// Whoever spawns the shell names the front-door CLI through this variable;
/// the guest sees it as GENEHUB_CLI.
pub const ENV_CLI: &str = "GENEHUB_LOCAL_CLI";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "GENEHUB_LOCAL_HOST_PID";
/// The shell's host name, handed to the WASI guest for same-machine locks.
pub const ENV_HOST_NAME: &str = "GENEHUB_LOCAL_HOST_NAME";
/// The directory the daemon was started in; a WASI guest cannot ask the OS.
pub const ENV_CWD: &str = "GENEHUB_LOCAL_CWD";
/// The component file the shell loaded; the daemon watches it to ask for an
/// in-place reload when it changes.
pub const ENV_COMPONENT_FILE: &str = "GENEHUB_LOCAL_COMPONENT_FILE";
/// Content-addressed module id in `genehub.component.artifact.v3`. The App ↔
/// Component ABI is pinned by the WIT digest in `abi.rs`, not by a number.
pub const MODULE_ID: &str = "genehub:client-component/wasm";
/// Stamped signed-component discovery URLs. Empty for local.
pub const COMPONENT_MANIFEST_URLS: &[&str] = &[];
/// Data-dir env the desktop/CLI already stamps; the host store lives under it.
pub const ENV_DATA_DIR: &str = "GENEHUB_LOCAL_DATA_DIR";
