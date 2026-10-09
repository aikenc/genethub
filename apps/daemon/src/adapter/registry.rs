//! Which agents exist on this machine, and what they can do.
//!
//! Two kinds, and only two:
//!
//! - native adapters compiled into the daemon — the built-in Agent (and test
//!   doubles). They answer `probe` / `catalog`; the registry asks them in
//!   the background, each with its own deadline, and keeps the last answer.
//! - script Agents, one per directory under `<data>/agents`. They push their
//!   own state; the registry only reads the snapshot.
//!
//! Nothing here knows the name of any third-party Agent.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use genehub_proto::{AgentInfo, AgentRequestOutcome, AgentUserRequest, ProbeState};
use tokio::sync::{broadcast, RwLock};

use super::genet::GenetAdapter;
use super::script::host::{AgentHost, HostEnv};
use super::script::layout::{self, Layout};
use super::script::runtime::Runtime;
use super::script::{RegistryEvent, ScriptAdapter};
use super::{ImportCandidate, ImportedHistory, ProviderMap, SharedAdapter};

/// How long one native adapter may take to answer `probe` + `catalog`.
const NATIVE_DEADLINE: Duration = Duration::from_secs(10);

struct Script {
    host: Arc<AgentHost>,
    adapter: SharedAdapter,
}

pub struct Registry {
    native: Vec<SharedAdapter>,
    native_cache: RwLock<BTreeMap<String, AgentInfo>>,
    scripts: std::sync::RwLock<BTreeMap<String, Script>>,
    layout: Option<Layout>,
    runtime: Option<Arc<Runtime>>,
    env: HostEnv,
    events: broadcast::Sender<RegistryEvent>,
    warmed: std::sync::atomic::AtomicBool,
}

impl Registry {
    /// The built-in Agent plus every script Agent directory under
    /// `<data_root>/agents`, materializing the built-in ones first.
    pub fn new(data_root: &Path, front_door_cli: Option<PathBuf>) -> Self {
        let layout = Layout::new(data_root);
        if let Err(error) = layout.materialize() {
            tracing::warn!(%error, "could not materialize built-in script Agents");
        }
        let runtime = Arc::new(Runtime::new(layout.runtime_dir()));
        let (events, _) = broadcast::channel(256);
        let registry = Registry {
            native: vec![Arc::new(GenetAdapter::discover())],
            native_cache: RwLock::new(BTreeMap::new()),
            scripts: std::sync::RwLock::new(BTreeMap::new()),
            layout: Some(layout.clone()),
            runtime: Some(runtime),
            env: HostEnv {
                channel: crate::channel::CHANNEL.to_string(),
                front_door_cli,
            },
            events,
            warmed: Default::default(),
        };
        for id in layout.ids() {
            registry.add_script(&id);
        }
        registry
    }

    /// Exactly these native adapters and no script Agents, for tests that
    /// drive the session manager without anything installed.
    #[cfg(test)]
    pub(crate) fn of(adapters: Vec<SharedAdapter>) -> Self {
        let (events, _) = broadcast::channel(16);
        Registry {
            native: adapters,
            native_cache: RwLock::new(BTreeMap::new()),
            scripts: std::sync::RwLock::new(BTreeMap::new()),
            layout: None,
            runtime: None,
            env: HostEnv {
                channel: "test".into(),
                front_door_cli: None,
            },
            events,
            warmed: Default::default(),
        }
    }

    /// Only the built-in Agent, for tests.
    #[cfg(test)]
    pub(crate) fn builtin_only() -> Self {
        Registry::of(vec![Arc::new(GenetAdapter::discover())])
    }

    fn add_script(&self, id: &str) -> Option<Arc<AgentHost>> {
        let (layout, runtime) = (self.layout.clone()?, self.runtime.clone()?);
        let host = AgentHost::new(
            id.to_string(),
            layout,
            runtime,
            self.env.clone(),
            self.events.clone(),
        );
        let adapter: SharedAdapter = Arc::new(ScriptAdapter::new(host.clone()));
        // Two reloads of a new id at once must not leave a second host (and
        // its process) running unregistered.
        let mut scripts = self.scripts.write().expect("never poisoned");
        let entry = scripts.entry(id.to_string()).or_insert(Script {
            host: host.clone(),
            adapter,
        });
        Some(entry.host.clone())
    }

    /// Starts every script Agent's process in the background the first time
    /// anyone asks what Agents exist. Not at daemon start: a daemon nobody is
    /// looking at has no reason to run Agent processes.
    fn warm(&self) {
        if self.warmed.swap(true, std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        for host in self.hosts() {
            host.warm();
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RegistryEvent> {
        self.events.subscribe()
    }

    /// The platform Python the installer recorded, in the daemon's own path
    /// spelling, or `None` when none is installed.
    pub fn python(&self) -> Option<std::path::PathBuf> {
        let python = self.runtime.as_ref()?.python().ok()?;
        Some(crate::guest_paths::guest_path(&python))
    }

    fn hosts(&self) -> Vec<Arc<AgentHost>> {
        self.scripts
            .read()
            .expect("never poisoned")
            .values()
            .map(|script| script.host.clone())
            .collect()
    }

    pub fn host(&self, id: &str) -> Option<Arc<AgentHost>> {
        self.scripts
            .read()
            .expect("never poisoned")
            .get(id)
            .map(|script| script.host.clone())
    }

    pub fn get(&self, id: &str) -> Option<SharedAdapter> {
        if let Some(native) = self.native.iter().find(|adapter| adapter.id() == id) {
            return Some(native.clone());
        }
        self.scripts
            .read()
            .expect("never poisoned")
            .get(id)
            .map(|script| script.adapter.clone())
    }

    pub fn require(&self, id: &str) -> Result<SharedAdapter> {
        self.get(id)
            .ok_or_else(|| anyhow!("这个 Agent 现在不可用：{id}"))
    }

    fn adapters(&self) -> Vec<SharedAdapter> {
        let mut all = self.native.clone();
        all.extend(
            self.scripts
                .read()
                .expect("never poisoned")
                .values()
                .map(|script| script.adapter.clone()),
        );
        all
    }

    /// Used both before authoring succeeds and before a restricted Session is
    /// created/resumed. Agent-specific support stays inside the adapter layer.
    pub(crate) fn require_evidence_scope(&self, id: &str) -> Result<SharedAdapter> {
        let adapter = self.require(id)?;
        if !adapter.supports_evidence_scope() {
            let supported = self
                .adapters()
                .iter()
                .filter(|adapter| adapter.supports_evidence_scope())
                .map(|adapter| adapter.id().to_string())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::bail!("evidenceOnlyUnsupported: Agent '{id}' cannot enforce a bounded read-only evidence scope. Keep evidenceOnly enabled and select a supported Agent ({supported}) with a compatible model; do not widen workspace folders or disable the evidence boundary.");
        }
        Ok(adapter)
    }

    /// Every Agent as it stands now. Never waits on a script; waits on a
    /// native adapter only the first time, bounded by its own deadline.
    pub async fn list(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        self.warm();
        let missing = {
            let cache = self.native_cache.read().await;
            self.native
                .iter()
                .any(|adapter| !cache.contains_key(adapter.id()))
        };
        if missing {
            self.probe_native(providers).await;
        }
        self.snapshot().await
    }

    /// Asks every Agent to look again and returns what is known right now;
    /// script answers arrive later as `agents` pushes.
    pub async fn refresh(&self, providers: &ProviderMap) -> Vec<AgentInfo> {
        self.warmed.store(true, std::sync::atomic::Ordering::SeqCst);
        for host in self.hosts() {
            host.refresh();
        }
        self.probe_native(providers).await;
        self.snapshot().await
    }

    async fn probe_native(&self, providers: &ProviderMap) {
        let answers =
            futures_util::future::join_all(self.native.iter().map(|adapter| async move {
                let asked = tokio::time::timeout(NATIVE_DEADLINE, async {
                    adapter.invalidate_catalog().await;
                    let probe = adapter.probe().await;
                    let catalog = if matches!(probe, ProbeState::Ready) {
                        adapter.catalog(providers).await
                    } else {
                        Default::default()
                    };
                    (probe, catalog)
                })
                .await;
                (adapter.clone(), asked)
            }))
            .await;
        let mut cache = self.native_cache.write().await;
        for (adapter, asked) in answers {
            let Ok((probe, catalog)) = asked else {
                // Keep the last answer rather than blank the picker.
                if !cache.contains_key(adapter.id()) {
                    cache.insert(
                        adapter.id().to_string(),
                        native_info(
                            &adapter,
                            ProbeState::Unavailable {
                                reason: "探测超时".into(),
                            },
                            Default::default(),
                        ),
                    );
                }
                continue;
            };
            cache.insert(
                adapter.id().to_string(),
                native_info(&adapter, probe, catalog),
            );
        }
    }

    async fn snapshot(&self) -> Vec<AgentInfo> {
        let mut infos: Vec<AgentInfo> = {
            let cache = self.native_cache.read().await;
            self.native
                .iter()
                .filter_map(|adapter| cache.get(adapter.id()).cloned())
                .collect()
        };
        infos.extend(self.hosts().iter().map(|host| host.info()));
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

    // -- script Agent control ---------------------------------------------------

    fn script_host(&self, id: &str) -> Result<Arc<AgentHost>> {
        self.host(id)
            .ok_or_else(|| anyhow!("{id} 不是脚本 Agent，或者它的目录不存在"))
    }

    pub async fn run_action(&self, id: &str, action: &str) -> Result<String> {
        self.script_host(id)?.run_action(action).await
    }

    pub async fn answer(
        &self,
        id: &str,
        request_id: &str,
        outcome: AgentRequestOutcome,
    ) -> Result<()> {
        self.script_host(id)?.answer(request_id, outcome).await
    }

    /// The only way an edit under `user/` takes effect. A directory that is
    /// new to this daemon is picked up here too.
    pub async fn reload(&self, id: &str) -> Result<()> {
        if !layout::valid_id(id) {
            anyhow::bail!("Agent 名字必须匹配 ^[a-z][a-z0-9-]{{1,31}}$");
        }
        let host = match self.host(id) {
            Some(host) => host,
            None => {
                let layout = self
                    .layout
                    .as_ref()
                    .ok_or_else(|| anyhow!("这个 daemon 没有脚本 Agent 目录"))?;
                if layout.resolve(id, false).is_none() {
                    anyhow::bail!("{} 下没有 {id}", layout.root().display());
                }
                self.add_script(id)
                    .ok_or_else(|| anyhow!("无法登记 {id}"))?
            }
        };
        host.reload().await
    }

    pub async fn reset(&self, id: &str) -> Result<()> {
        self.script_host(id)?.reset().await
    }

    pub async fn test(&self, id: &str, live: bool) -> Result<(bool, String)> {
        self.script_host(id)?.test(live).await
    }

    pub fn logs(&self, id: &str, lines: usize) -> Result<Vec<String>> {
        Ok(self.script_host(id)?.logs(lines))
    }

    pub fn requests(&self) -> Vec<AgentUserRequest> {
        self.hosts()
            .iter()
            .flat_map(|host| host.requests())
            .collect()
    }

    /// Stops every script process, e.g. before the daemon reloads.
    pub async fn shutdown(&self) {
        futures_util::future::join_all(self.hosts().iter().map(|host| host.shutdown())).await;
    }

    // -- import ---------------------------------------------------------------------

    /// Discovers external histories in parallel. Each result retains its own
    /// error so one broken CLI cannot erase every other Agent's import entry.
    pub async fn import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Vec<(String, String, Result<Option<Vec<ImportCandidate>>>)> {
        futures_util::future::join_all(self.adapters().into_iter().map(|adapter| async move {
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

fn native_info(
    adapter: &SharedAdapter,
    probe: ProbeState,
    catalog: genehub_proto::Catalog,
) -> AgentInfo {
    AgentInfo {
        id: adapter.id().to_string(),
        label: adapter.label().to_string(),
        probe,
        capabilities: adapter.capabilities(),
        catalog,
        builtin: adapter.builtin(),
        routes: None,
        source: None,
        version: None,
        description: None,
        message: None,
        actions: None,
        job: None,
        pending_requests: None,
        icon: None,
        dir: None,
        override_stale: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `agent.refresh` must drop a native adapter's handshake cache; `list`
    /// keeps the registry's own.
    #[tokio::test]
    async fn refresh_asks_each_native_adapter_for_a_new_catalog() {
        struct Cached {
            latest: tokio::sync::RwLock<String>,
            remembered: tokio::sync::RwLock<Option<genehub_proto::Catalog>>,
        }

        #[async_trait::async_trait]
        impl crate::adapter::AgentAdapter for Cached {
            fn id(&self) -> &str {
                "cached"
            }
            fn label(&self) -> &str {
                "Cached"
            }
            fn capabilities(&self) -> genehub_proto::Capabilities {
                Default::default()
            }
            async fn probe(&self) -> ProbeState {
                ProbeState::Ready
            }
            async fn invalidate_catalog(&self) {
                *self.remembered.write().await = None;
            }
            async fn catalog(&self, _providers: &ProviderMap) -> genehub_proto::Catalog {
                if let Some(cached) = self.remembered.read().await.clone() {
                    return cached;
                }
                let id = self.latest.read().await.clone();
                let catalog = genehub_proto::Catalog {
                    models: vec![genehub_proto::ModelInfo {
                        id: id.clone(),
                        label: id,
                        context_window: None,
                        reasoning: false,
                        efforts: Vec::new(),
                        input_modalities: None,
                        supports_fast: false,
                    }],
                    ..Default::default()
                };
                *self.remembered.write().await = Some(catalog.clone());
                catalog
            }
            async fn start(
                &self,
                _config: crate::adapter::SessionConfig,
            ) -> Result<Box<dyn crate::adapter::AgentSession>> {
                anyhow::bail!("not started")
            }
        }

        let adapter = Arc::new(Cached {
            latest: tokio::sync::RwLock::new("old".into()),
            remembered: tokio::sync::RwLock::new(None),
        });
        let registry = Registry::of(vec![adapter.clone()]);
        let providers = ProviderMap::new();
        let first = registry.list(&providers).await;
        assert_eq!(first[0].catalog.models[0].id, "old");

        *adapter.latest.write().await = "new".into();
        let listed = registry.list(&providers).await;
        assert_eq!(
            listed[0].catalog.models[0].id, "old",
            "list keeps the cache"
        );
        let refreshed = registry.refresh(&providers).await;
        assert_eq!(refreshed[0].catalog.models[0].id, "new");
    }
}
