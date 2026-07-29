//! The agent adapter layer.
//!
//! Boundary B1 in `docs/architecture.md`: nothing outside this directory may
//! know which agent is in use. Adapters translate their agent's wire format
//! into `SessionEvent` and accept a fixed set of commands; the session kernel
//! and every transport above it see only those.

pub mod acp;
pub mod claude;
pub mod genet;
pub mod opencode;
pub mod registry;
pub mod stdio;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use genehub_proto::{
    Attachment, Capabilities, Catalog, PermissionOutcome, ProbeState, SessionEvent,
};
use tokio::sync::broadcast;

use crate::config::ProviderConfig;

/// Everything an adapter needs to start a session.
#[derive(Debug, Clone)]
pub struct SessionConfig {
    pub session_id: String,
    pub cwd: PathBuf,
    pub model_id: Option<String>,
    pub mode_id: Option<String>,
    /// Where the adapter may keep agent-private state for this session.
    pub scratch_dir: PathBuf,
    /// Provider credentials, keyed by provider id.
    ///
    /// Tests point `base_url` at a local mock and change nothing else, which is
    /// what keeps mock and real runs on the same code path
    /// (`docs/testing.md` §2.1).
    pub providers: std::collections::BTreeMap<String, ProviderConfig>,
    /// Handle from a previous run when the agent can rehydrate itself.
    pub resume: Option<PersistHandle>,
}

/// Opaque per-agent pointer to resumable state.
///
/// The daemon stores and returns it without interpreting it: what counts as
/// resumable is the agent's business, not ours.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct PersistHandle {
    pub agent_id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct PromptInput {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

#[async_trait]
pub trait AgentAdapter: Send + Sync {
    fn id(&self) -> &str;
    fn label(&self) -> &str;

    /// True only for the agent shipped in the installer.
    fn builtin(&self) -> bool {
        false
    }

    fn capabilities(&self) -> Capabilities;

    /// Is it installed and does it answer? Never an error: "not installed" is a
    /// normal state that simply hides the agent from the picker.
    async fn probe(&self) -> ProbeState;

    async fn catalog(&self, providers: &ProviderMap) -> Catalog;

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>>;
}

pub type ProviderMap = std::collections::BTreeMap<String, ProviderConfig>;

#[async_trait]
pub trait AgentSession: Send + Sync {
    /// The one and only output: already-normalized events.
    fn events(&self) -> broadcast::Receiver<SessionEvent>;

    async fn send(&self, input: PromptInput) -> Result<String>;
    async fn interrupt(&self) -> Result<()>;
    async fn close(&self) -> Result<()>;

    async fn set_model(&self, model_id: &str) -> Result<()>;
    async fn set_mode(&self, mode_id: &str) -> Result<()>;
    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()>;

    /// `None` means the daemon must fall back to read-only replay of its own log.
    fn persistence(&self) -> Option<PersistHandle> {
        None
    }
}

pub type SharedAdapter = Arc<dyn AgentAdapter>;

/// Finds an executable on `PATH`, honouring `PATHEXT` on Windows.
pub fn find_executable(name: &str) -> Option<PathBuf> {
    if name.contains(std::path::MAIN_SEPARATOR) {
        let direct = PathBuf::from(name);
        return direct.is_file().then_some(direct);
    }
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
            .split(';')
            .map(|e| e.to_lowercase())
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_paths_resolve_only_when_they_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(find_executable(missing.to_str().unwrap()).is_none());

        let present = dir.path().join("here");
        std::fs::write(&present, b"").unwrap();
        assert_eq!(find_executable(present.to_str().unwrap()), Some(present));
    }

    #[test]
    fn a_binary_that_is_not_installed_resolves_to_none() {
        assert!(find_executable("genehub-definitely-not-installed").is_none());
    }
}
