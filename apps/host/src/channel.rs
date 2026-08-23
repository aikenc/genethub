//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.mjs` — edit that script, not this
//! file. The shell and the guest are separate crates that must agree on the
//! names things are handed over with, so the shell reads the same stamped
//! constants the guest's crates do.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `dev` | `official` | `beta` | `alpha`.
pub const CHANNEL: &str = "dev";
/// Whoever spawns the shell names the front-door CLI through this variable;
/// the guest sees it as GENEHUB_CLI.
pub const ENV_CLI: &str = "GENEHUB_DEV_CLI";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "GENEHUB_DEV_HOST_PID";
/// The directory the daemon was started in; a WASI guest cannot ask the OS.
pub const ENV_CWD: &str = "GENEHUB_DEV_CWD";
/// The component file the shell loaded; the daemon watches it to ask for an
/// in-place reload when it changes.
pub const ENV_COMPONENT_FILE: &str = "GENEHUB_DEV_COMPONENT_FILE";
/// Host ABI integer written into signed guest envelopes. Bump when
/// `wit/genehub-host.wit` changes a load-time contract.
pub const HOST_ABI: u32 = 23;
/// Content-addressed module id in `genehub.daemon.artifact.v2`.
pub const MODULE_ID: &str = "genehub:guest/wasm";
/// Stamped signed-logic discovery URLs. Empty for dev: a source build is
/// not on the update scale.
pub const LOGIC_MANIFEST_URLS: &[&str] = &[];
/// Data-dir env the desktop/CLI already stamps; the host store lives under it.
pub const ENV_DATA_DIR: &str = "GENEHUB_DEV_DATA_DIR";
