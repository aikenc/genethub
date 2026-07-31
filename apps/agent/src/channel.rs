//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.sh` — edit that script, not this
//! file. The daemon has the full set of names; the agent only needs to find
//! its own home directory, and it reads the same override name the daemon
//! writes when it spawns one.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `official` | `beta`.
pub const CHANNEL: &str = "official";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub";
pub const ENV_HOME: &str = "GENET_AGENT_HOME";
pub const HOME_DIR_NAME: &str = ".genet-agent";
