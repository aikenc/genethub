//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.mjs` — edit that script, not this
//! file. The tree always says `dev`; a release build is the workflow
//! stamping its channel in before it compiles.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `dev` | `official` | `beta` | `alpha`.
pub const CHANNEL: &str = "dev";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub Dev";
/// The shell's slice of state, joined under `app_data_dir()`. Two derivation
/// chains exist and both have to move together: this one follows the
/// identifier (which channel.mjs also stamps), and the daemon's own
/// `dirs::data_dir()` root follows DATA_DIR_NAME in its copy of this module.
pub const DATA_DIR_NAME: &str = "GeneHub-dev";
/// What the shell spawns (with `daemon run`): the merged CLI+daemon binary.
pub const CLI_BINARY: &str = "genet-dev";
/// The wasm shell staged next to the CLI: the desktop spawns it directly with
/// `genehub_guest.wasm` when both are found beside the CLI binary.
pub const HOST_BINARY: &str = "genehub-host-dev";
/// Names the front-door CLI to the wasm shell it spawns; the shell hands it
/// to the guest as GENEHUB_CLI.
pub const ENV_CLI: &str = "GENEHUB_DEV_CLI";
/// The override the shell passes to the daemon it spawns — has to stay the
/// name the daemon reads (`apps/daemon/src/channel.rs`), or the shell and
/// the daemon disagree about where the data lives and the shell ends up
/// adopting the other channel's daemon through a stale endpoint file.
pub const ENV_DATA_DIR: &str = "GENEHUB_DEV_DATA_DIR";
pub const TRAY_ID: &str = "genethub-tray-dev";
