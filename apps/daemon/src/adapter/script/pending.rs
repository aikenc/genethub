//! Non-secret continuation records. No live RPC, credential, or CLI is a
//! prerequisite for keeping a Human decision outstanding.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use genehub_proto::{AgentRequestOutcome, AgentUserRequest};
use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PendingAction {
    pub request: AgentUserRequest,
    pub job: String,
    pub action: String,
    pub step: String,
    /// Preparation is committed before the script unwinds. Only a confirmed
    /// stop may become a Human card. Older post-stop records default to true.
    #[serde(default = "already_stopped")]
    pub stopped: bool,
    /// Bound to the loaded adapter and SDK, never supplied by the script.
    #[serde(default)]
    pub revision: Option<String>,
    /// Saved before dispatch. On recovery an uncertain operation must be
    /// inspected, never automatically replayed (in particular secret answers
    /// cannot be recovered from this record).
    #[serde(default)]
    pub claimed: bool,
    /// Ordinary answers survive an uncertain dispatch. Secret fields are
    /// removed before writing; they must be entered again for a new action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decision: Option<AgentRequestOutcome>,
}

pub(super) type PendingActions = BTreeMap<String, PendingAction>;
fn already_stopped() -> bool {
    true
}

pub(super) fn load(path: &Path) -> Result<PendingActions> {
    match std::fs::read(path) {
        Ok(bytes) => {
            anyhow::ensure!(
                bytes.len() <= 2 * 1024 * 1024,
                "pending record is too large"
            );
            let actions: PendingActions = serde_json::from_slice(&bytes)?;
            anyhow::ensure!(actions.len() <= 64, "too many pending records");
            Ok(actions)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.into()),
    }
}

pub(super) fn save(path: &Path, actions: &PendingActions) -> Result<()> {
    let parent = path.parent().expect("pending file has a parent");
    std::fs::create_dir_all(parent)?;
    crate::config::save_private(path, &serde_json::to_vec(actions)?)
}
