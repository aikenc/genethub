//! Which release channel this build belongs to.
//!
//! Written wholesale by `scripts/channel.sh` — edit that script, not this
//! file. The tree always says `official`; a beta build is the release
//! workflow stamping `beta` in before it compiles, exactly the way
//! `scripts/version.sh` stamps the version.

// Not every build reads every name below; the module is the whole menu so
// that adding a consumer never means editing the generator.
#![allow(dead_code)]

/// `official` | `beta`.
pub const CHANNEL: &str = "official";
/// What the product calls itself on screen.
pub const PRODUCT: &str = "GeneHub";
/// Root of everything the daemon owns, under the platform data directory.
pub const DATA_DIR_NAME: &str = "GeneHub";
/// The folder the agent works in until the user points it somewhere else.
pub const WORKSPACE_DIR_NAME: &str = "GeneHub";
/// The one binary: CLI to agents, daemon as `genet daemon run`.
pub const CLI_BINARY: &str = "genet";
pub const AGENT_BINARY: &str = "genet-agent";
/// Where the agent keeps its sessions and `models.json`, under the home dir.
pub const AGENT_HOME_DIR: &str = ".genet-agent";
pub const ENV_DATA_DIR: &str = "GENEHUB_DATA_DIR";
pub const ENV_WORKSPACE_DIR: &str = "GENEHUB_WORKSPACE_DIR";
pub const ENV_LOG: &str = "GENEHUB_LOG";
pub const ENV_MACHINE_NAME: &str = "GENEHUB_MACHINE_NAME";
pub const ENV_AGENT_COMMAND: &str = "GENET_AGENT_COMMAND";
pub const ENV_AGENT_HOME: &str = "GENET_AGENT_HOME";
/// What the owner sees this machine called before they name it.
pub const DEFAULT_MACHINE_NAME: &str = "GeneHub machine";
/// What the built-in agent calls itself in the picker.
pub const AGENT_LABEL: &str = "GeneHub Agent";
/// Where the published builds of this channel announce themselves.
// Broken across two lines: either channel's URL is longer than rustfmt's
// line budget, and CI rejects a tree rustfmt would rewrite.
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/aikenc/genethub/releases/latest/download/latest.json";
/// Default Hub for `genet hub login` and a standalone first pair.
pub const DEFAULT_HUB_URL: &str = "https://relay.genethub.com";
pub const ENV_HUB_URL: &str = "GENEHUB_HUB_URL";
