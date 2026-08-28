//! Build identity: `local` for a source tree, otherwise the release channel.
//!
//! Written wholesale by `scripts/channel.mjs` — edit that script, not this
//! file. The tree always says `local`; a release build is the workflow
//! stamping its channel in before it compiles, exactly the way
//! `scripts/stamp-version.mjs` stamps the version.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `local` | `dev` | `beta` | `stable`.
pub const CHANNEL: &str = "local";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub Local";
/// Root of everything the daemon owns, under the platform data directory.
pub const DATA_DIR_NAME: &str = "GeneHub-local";
/// The folder the agent works in until the user points it somewhere else.
pub const WORKSPACE_DIR_NAME: &str = "GeneHub-local";
/// The one binary: CLI to agents, daemon as `genet daemon run`.
pub const CLI_BINARY: &str = "genet-local";
pub const AGENT_BINARY: &str = "genet-agent-local";
/// The wasm shell next to the CLI: loads `genehub_guest.wasm` and runs its
/// daemon or agent entry. The CLI refuses to start a daemon without it.
pub const HOST_BINARY: &str = "genehub-host-local";
/// Where the agent keeps its sessions and `models.json`, under the home dir.
pub const AGENT_HOME_DIR: &str = ".genet-agent-local";
pub const ENV_DATA_DIR: &str = "GENEHUB_LOCAL_DATA_DIR";
pub const ENV_WORKSPACE_DIR: &str = "GENEHUB_LOCAL_WORKSPACE_DIR";
pub const ENV_LOG: &str = "GENEHUB_LOCAL_LOG";
/// The shell's pid, handed to the WASI guest which has none of its own.
pub const ENV_HOST_PID: &str = "GENEHUB_LOCAL_HOST_PID";
/// The shell's host name, handed to the WASI guest for same-machine locks.
pub const ENV_HOST_NAME: &str = "GENEHUB_LOCAL_HOST_NAME";
pub const ENV_MACHINE_NAME: &str = "GENEHUB_LOCAL_MACHINE_NAME";
pub const ENV_AGENT_COMMAND: &str = "GENET_AGENT_LOCAL_COMMAND";
/// Runs the daemon instead of `genet daemon run`, for pointing the product at
/// the wasm guest under its shell. Mirrors `ENV_AGENT_COMMAND`: a binary that
/// already knows what it is, so no argv is appended.
pub const ENV_DAEMON_COMMAND: &str = "GENEHUB_LOCAL_DAEMON_COMMAND";
/// Whoever spawns the wasm shell names the front-door CLI through this
/// variable; the shell hands it to the guest as GENEHUB_CLI.
pub const ENV_CLI: &str = "GENEHUB_LOCAL_CLI";
/// The component file the shell loaded, handed to the guest so the daemon
/// can watch it and ask for an in-place reload when it changes.
pub const ENV_COMPONENT_FILE: &str = "GENEHUB_LOCAL_COMPONENT_FILE";
pub const ENV_AGENT_HOME: &str = "GENET_AGENT_LOCAL_HOME";
/// What the owner sees this machine called before they name it.
pub const DEFAULT_MACHINE_NAME: &str = "GeneHub Local machine";
/// What the built-in agent calls itself in the picker.
pub const AGENT_LABEL: &str = "GeneHub Local Agent";
/// Where the published builds of this channel announce themselves.
/// Empty for local: a source build is not on the update scale at all.
pub const DEFAULT_MANIFEST_URL: &str = "";
/// Default Hub for `genet hub login` and a standalone first pair.
/// Empty for local: a source build points nowhere unless told.
pub const DEFAULT_HUB_URL: &str = "";
pub const ENV_HUB_URL: &str = "GENEHUB_LOCAL_HUB_URL";
/// Channel website the Desktop shell navigates to after boot.
pub const WEB_APP_URL: &str = "http://127.0.0.1:5173/app";
