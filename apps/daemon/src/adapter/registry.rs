//! Which agents exist on this machine, and what they can do.

use std::collections::BTreeMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use genehub_proto::{AgentInfo, ProbeState};
use tokio::sync::RwLock;

use super::acp::AcpAdapter;
use super::genet::GenetAdapter;
use super::opencode::OpenCodeAdapter;
use super::{ProviderMap, SharedAdapter};
use crate::config::CustomAgent;

pub struct Registry {
    adapters: Vec<SharedAdapter>,
    cache: RwLock<Option<Vec<AgentInfo>>>,
}

impl Registry {
    /// Builds the adapter set: the built-ins, plus whatever the user declared.
    pub fn new(custom: &BTreeMap<String, CustomAgent>) -> Self {
        let mut adapters: Vec<SharedAdapter> = vec![
            Arc::new(GenetAdapter::discover()),
            Arc::new(OpenCodeAdapter),
            // Claude Code and Codex are both ACP-speaking once wrapped by their
            // maintainers' own adapters (`claude-agent-acp`, `codex-acp`). We
            // spawn the CLI and translate its wire format like any other
            // adapter; which backend it talks to is that CLI's own
            // configuration (env vars, its native config file, ChatGPT login,
            // …), never something this daemon reaches into
            // (`docs/architecture.md` §3, boundary B1).
            Arc::new(AcpAdapter::new(
                "claude",
                "Claude Code",
                vec!["claude-agent-acp".into()],
            )),
            Arc::new(AcpAdapter::new("codex", "Codex", vec!["codex-acp".into()])),
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
        let mut infos = Vec::new();
        for adapter in &self.adapters {
            let probe = adapter.probe().await;
            // Cataloguing an absent agent would spawn a process that is not
            // there; skip straight to an empty catalog.
            let catalog = if matches!(probe, ProbeState::Ready) {
                adapter.catalog(providers).await
            } else {
                Default::default()
            };
            infos.push(AgentInfo {
                id: adapter.id().to_string(),
                label: adapter.label().to_string(),
                probe,
                capabilities: adapter.capabilities(),
                catalog,
                builtin: adapter.builtin(),
            });
        }
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

    /// Claude Code and Codex ship no code of ours; they are ACP-wrapped CLIs
    /// like any custom `extends: "acp"` entry, just registered by default so
    /// users do not have to hand-write the config (`docs/architecture.md` §3).
    #[tokio::test]
    async fn claude_and_codex_are_registered_out_of_the_box_as_ordinary_acp_agents() {
        let registry = Registry::new(&BTreeMap::new());
        let claude = registry.get("claude").expect("claude is registered");
        assert!(!claude.builtin());
        assert_eq!(claude.label(), "Claude Code");
        let codex = registry.get("codex").expect("codex is registered");
        assert!(!codex.builtin());
        assert_eq!(codex.label(), "Codex");
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
