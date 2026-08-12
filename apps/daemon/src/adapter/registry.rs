//! Which agents exist on this machine, and what they can do.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use genehub_proto::{AgentInfo, ProbeState};
use tokio::sync::RwLock;

use super::acp::AcpAdapter;
use super::claude::ClaudeAdapter;
use super::codex::CodexAdapter;
use super::genet::GenetAdapter;
use super::opencode::OpenCodeAdapter;
use super::{ImportCandidate, ImportedHistory, ProviderMap, SharedAdapter};
use crate::config::CustomAgent;

pub struct Registry {
    adapters: Vec<SharedAdapter>,
    cache: RwLock<Option<Vec<AgentInfo>>>,
}

fn cursor_command() -> Vec<String> {
    [
        "cursor-agent",
        "--force",
        "--sandbox",
        "disabled",
        "--trust",
        "--approve-mcps",
        "acp",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

impl Registry {
    /// Builds the adapter set: the built-ins, plus whatever the user declared.
    pub fn new(custom: &BTreeMap<String, CustomAgent>) -> Self {
        let mut adapters: Vec<SharedAdapter> = vec![
            Arc::new(GenetAdapter::discover()),
            Arc::new(OpenCodeAdapter),
            // Claude Code is spoken natively (`adapter::claude`): its own
            // `stream-json` stdio protocol, not the `claude-agent-acp`
            // wrapper. Going native buys back per-tool permission control
            // that ACP does not expose to a client; see that module's doc
            // comment for the reverse-engineered protocol notes.
            Arc::new(ClaudeAdapter::default()),
            // Codex likewise (`adapter::codex`): its own `app-server`
            // JSON-RPC, not `codex-acp`. Which also removes an install step
            // nobody could guess at — this entry used to report "not
            // installed" to anyone who had `codex` but not the bridge.
            Arc::new(CodexAdapter::default()),
            // Cursor, spoken as ACP (`cursor-agent acp`): the protocol its CLI
            // publishes for exactly this kind of embedding. Launch flags give
            // the CLI maximum authority; any residual ACP permission request
            // becomes a durable stopped interaction in the session manager.
            Arc::new(AcpAdapter::new("cursor", "Cursor", cursor_command())),
            // A generic ACP entry so any other ACP-speaking CLI on PATH works
            // with no configuration at all.
            Arc::new(AcpAdapter::new(
                "acp",
                "ACP agent",
                vec!["acp-agent".into()],
            )),
        ];

        for (id, agent) in custom {
            match agent.extends.as_str() {
                "acp" => adapters.push(Arc::new(AcpAdapter::new(
                    format!("acp:{id}"),
                    agent.label.clone().unwrap_or_else(|| id.clone()),
                    agent.command.clone(),
                ))),
                other => {
                    tracing::warn!("ignoring custom agent '{id}': unknown base adapter '{other}'");
                }
            }
        }

        Registry {
            adapters,
            cache: RwLock::new(None),
        }
    }

    /// A registry of exactly these adapters, for tests that need to drive the
    /// session manager without a real agent on the machine.
    #[cfg(test)]
    pub(crate) fn of(adapters: Vec<SharedAdapter>) -> Self {
        Registry {
            adapters,
            cache: RwLock::new(None),
        }
    }

    pub fn get(&self, id: &str) -> Option<SharedAdapter> {
        self.adapters
            .iter()
            .find(|adapter| adapter.id() == id)
            .cloned()
    }

    pub fn require(&self, id: &str) -> Result<SharedAdapter> {
        self.get(id)
            .ok_or_else(|| anyhow!("no adapter registered for '{id}'"))
    }

    /// Probes every adapter and caches the result.
    ///
    /// Probing spawns processes, so the agent picker must not do it on every
    /// open; `refresh` exists for when the user installs something.
    pub async fn list(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        if let Some(cached) = self.cache.read().await.clone() {
            return cached;
        }
        self.refresh(providers).await
    }

    pub async fn refresh(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        // These probes are independent subprocesses. Running them serially
        // made the first AgentList wait for every optional CLI's timeout in
        // sequence, which looked like a dead connection on a cold install.
        // `join_all` preserves registry order while bounding the wait to the
        // slowest probe instead of the sum of all of them.
        let infos =
            futures_util::future::join_all(self.adapters.iter().map(|adapter| async move {
                let probe = adapter.probe().await;
                // Cataloguing an absent agent would spawn a process that is not
                // there; skip straight to an empty catalog.
                let catalog = if matches!(probe, ProbeState::Ready) {
                    adapter.catalog(providers).await
                } else {
                    Default::default()
                };
                AgentInfo {
                    id: adapter.id().to_string(),
                    label: adapter.label().to_string(),
                    probe,
                    capabilities: adapter.capabilities(),
                    catalog,
                    builtin: adapter.builtin(),
                }
            }))
            .await;
        *self.cache.write().await = Some(infos.clone());
        infos
    }

    /// Agents the user can actually pick right now.
    pub async fn available(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        self.list(providers)
            .await
            .into_iter()
            .filter(|agent| matches!(agent.probe, ProbeState::Ready))
            .collect()
    }

    /// Discovers external histories in parallel. Each result retains its own
    /// error so one broken CLI cannot erase every other Agent's import entry.
    pub async fn import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Vec<(String, String, Result<Option<Vec<ImportCandidate>>>)> {
        futures_util::future::join_all(self.adapters.iter().map(|adapter| async move {
            (
                adapter.id().to_string(),
                adapter.label().to_string(),
                adapter.list_import_candidates(cwd, limit).await,
            )
        }))
        .await
    }

    pub async fn import_history(
        &self,
        agent_id: &str,
        cwd: &Path,
        source_id: &str,
    ) -> Result<ImportedHistory> {
        self.require(agent_id)?.import_history(cwd, source_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_built_in_agent_is_always_registered_and_marked_builtin() {
        let registry = Registry::new(&BTreeMap::new());
        let genet = registry.get("genet").expect("the built-in agent");
        assert!(genet.builtin());
        assert!(!registry.get("opencode").unwrap().builtin());
    }

    /// Both are registered by default so users never have to hand-write a
    /// config entry just to reach a CLI this common
    /// (`docs/architecture.md` §3), and both are spoken natively: the only
    /// thing either one needs installed is itself. Registering Codex through
    /// the ACP wrapper used to mean telling someone who had `codex` that Codex
    /// was not installed, because a bridge package was missing.
    #[tokio::test]
    async fn claude_and_codex_are_registered_out_of_the_box() {
        let registry = Registry::new(&BTreeMap::new());
        let claude = registry.get("claude").expect("claude is registered");
        assert!(!claude.builtin());
        assert_eq!(claude.label(), "Claude Code");
        // Native, not the ACP wrapper: real per-tool permission control.
        assert!(claude.capabilities().permissions);
        assert!(claude.capabilities().resume);
        let codex = registry.get("codex").expect("codex is registered");
        assert!(!codex.builtin());
        assert_eq!(codex.label(), "Codex");
        assert!(codex.capabilities().permissions);
        // Three separate pickers, all of them real: this CLI takes the model,
        // the thinking level and the approval policy on every turn.
        assert!(codex.capabilities().set_model);
        assert!(codex.capabilities().set_effort);
        assert!(codex.capabilities().set_mode);
        assert!(codex.capabilities().resume);
        assert!(codex.capabilities().attachments);
        assert!(codex.capabilities().fork);
    }

    /// Cursor ships in the default set too (`docs/desktop-client.md` promises
    /// the picker detects a locally installed Cursor CLI), spoken as ACP rather
    /// than through a hand-written config entry.
    #[tokio::test]
    async fn cursor_is_registered_out_of_the_box() {
        let registry = Registry::new(&BTreeMap::new());
        let cursor = registry.get("cursor").expect("cursor is registered");
        assert!(!cursor.builtin());
        assert_eq!(cursor.label(), "Cursor");
        // Mode switching and pasted images both come through ACP. Residual
        // permission requests are supported as durable stopped interactions.
        assert!(cursor.capabilities().permissions);
        assert!(cursor.capabilities().set_model);
        assert!(cursor.capabilities().set_mode);
        assert!(cursor.capabilities().attachments);
        // Probing is honest either way: ready when `cursor-agent` is on PATH,
        // not installed when it is not — never an error the picker chokes on.
        assert!(matches!(
            cursor.probe().await,
            ProbeState::Ready | ProbeState::NotInstalled
        ));
    }

    #[test]
    fn cursor_cli_is_launched_with_maximum_authority() {
        assert_eq!(
            cursor_command(),
            [
                "cursor-agent",
                "--force",
                "--sandbox",
                "disabled",
                "--trust",
                "--approve-mcps",
                "acp",
            ]
        );
    }

    #[tokio::test]
    async fn a_custom_acp_agent_is_registered_without_code_changes() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "goose".to_string(),
            CustomAgent {
                extends: "acp".into(),
                command: vec!["goose".into(), "acp".into()],
                label: Some("Goose".into()),
            },
        );
        let registry = Registry::new(&custom);
        let agent = registry.get("acp:goose").expect("the custom agent");
        assert_eq!(agent.label(), "Goose");
    }

    #[tokio::test]
    async fn a_custom_agent_on_an_unknown_base_is_skipped_not_fatal() {
        let mut custom = BTreeMap::new();
        custom.insert(
            "weird".to_string(),
            CustomAgent {
                extends: "telepathy".into(),
                command: vec!["weird".into()],
                label: None,
            },
        );
        let registry = Registry::new(&custom);
        assert!(registry.get("acp:weird").is_none());
        assert!(registry.get("genet").is_some(), "the rest still load");
    }

    /// An agent that is not installed must disappear from the picker rather
    /// than appear and fail on click (`docs/testing.md` §4.2).
    #[tokio::test]
    async fn agents_that_are_not_installed_are_filtered_out_of_the_picker() {
        let registry = Registry::new(&BTreeMap::new());
        let providers = ProviderMap::new();
        let all = registry.refresh(&providers).await;
        let available = registry.available(&providers).await;

        assert!(all.iter().any(|a| a.id == "opencode"));
        for agent in &available {
            assert!(matches!(agent.probe, ProbeState::Ready));
        }
        assert!(available.len() <= all.len());
    }

    #[tokio::test]
    async fn requiring_an_unknown_adapter_is_an_error_not_a_panic() {
        let registry = Registry::new(&BTreeMap::new());
        assert!(registry.require("nope").is_err());
    }
}
