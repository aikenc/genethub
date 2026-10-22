//! Where this channel keeps its mutable data.
//!
//! One root, resolved the same way by everything that needs it: the update
//! store and derived artifacts, and the Agent tree the daemon materialises.
//! The daemon and this binary are installed together and share the root, so
//! the host can read what the daemon wrote without asking it.

use std::path::PathBuf;

use anyhow::{anyhow, Result};

use crate::channel;

/// `GENEHUB_<CHANNEL>_DATA_DIR` when the launching CLI named it, otherwise the
/// per-channel directory under `XDG_DATA_HOME`/`~/.local/share`.
pub fn root() -> Option<PathBuf> {
    std::env::var(channel::ENV_DATA_DIR)
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME").map(PathBuf::from).map(|home| {
                home.join(".local")
                    .join("share")
                    .join(match channel::CHANNEL {
                        "stable" => "GeneHub",
                        "beta" => "GeneHub-beta",
                        "dev" => "GeneHub-dev",
                        _ => "GeneHub-local",
                    })
            })
        })
}

/// The directory derived Wasm artifacts live in.
pub fn derived() -> Result<PathBuf> {
    root()
        .map(|root| root.join("component").join("derived"))
        .ok_or_else(|| anyhow!("no data directory for derived artifacts"))
}

/// Where the daemon materialises the Agent tree: `agents/builtin/<id>/`.
pub fn builtin_agents() -> Option<PathBuf> {
    root().map(|root| root.join("agents").join("builtin"))
}
