//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.sh` — edit that script, not this
//! file. The tree always says `official`; a beta build is the release
//! workflow stamping `beta` in before it compiles.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `official` | `beta`.
pub const CHANNEL: &str = "official";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub";
/// The shell's slice of state, joined under `app_data_dir()`. Two derivation
/// chains exist and both have to move together: this one follows the
/// identifier (which channel.sh also stamps), and the daemon's own
/// `dirs::data_dir()` root follows DATA_DIR_NAME in its copy of this module.
pub const DATA_DIR_NAME: &str = "GeneHub";
pub const DAEMON_BINARY: &str = "genet-daemon";
/// The override the shell passes to the daemon it spawns — has to stay the
/// name the daemon reads (`apps/daemon/src/channel.rs`), or the shell and
/// the daemon disagree about where the data lives and the shell ends up
/// adopting the other channel's daemon through a stale endpoint file.
pub const ENV_DATA_DIR: &str = "GENEHUB_DATA_DIR";
pub const TRAY_ID: &str = "genethub-tray";
