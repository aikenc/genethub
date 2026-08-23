//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.mjs` — edit that script, not this
//! file. The daemon has the full set of names; the agent only needs to find
//! its own home directory, and it reads the same override name the daemon
//! writes when it spawns one.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `local` | `dev` | `beta` | `stable`.
pub const CHANNEL: &str = "local";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub Local";
pub const ENV_HOME: &str = "GENET_AGENT_LOCAL_HOME";
pub const HOME_DIR_NAME: &str = ".genet-agent-local";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "GENEHUB_LOCAL_HOST_PID";
/// The directory the daemon was started in; a WASI guest cannot ask the OS.
pub const ENV_CWD: &str = "GENEHUB_LOCAL_CWD";
