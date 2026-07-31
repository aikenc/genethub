//! Everything the request handlers share.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use genehub_proto::{ProviderInfo, ServerFrame, Settings};
use tokio::sync::{broadcast, mpsc, RwLock};

use crate::adapter::registry::Registry;
use crate::adapter::ProviderMap;
use crate::config::{Config, MachineState, Paths, ProviderConfig};
use crate::devices::Devices;
use crate::link::SharedLink;
use crate::pty::{PtyMessage, Terminals};
use crate::remote::SharedRemote;
use crate::session::{SessionManager, Store};
use crate::workspace::Workspaces;

pub struct AppState {
    pub paths: Paths,
    pub config: Arc<RwLock<Config>>,
    pub machine: MachineState,
    pub registry: Arc<Registry>,
    pub sessions: SessionManager,
    pub workspaces: Workspaces,
    pub terminals: Arc<Terminals>,
    pub version: String,
    /// Token loopback and LAN clients must present.
    pub token: String,
    /// Who may reach this machine from outside. The judge of that question is
    /// this list, not a relay and not a control plane.
    pub devices: Devices,
    /// This machine's relationship with a Hub. Set once, right after the state
    /// exists, because the link needs the state to serve relayed clients.
    pub link: std::sync::OnceLock<SharedLink>,
    /// The rendezvous relay this machine waits at, if any. Set alongside the
    /// link and for the same reason.
    pub remote: std::sync::OnceLock<SharedRemote>,
    /// How far the installer fetch has got, when one was asked for.
    pub updates: crate::updates::Downloader,
    /// The channel every connected client is listening on.
    ///
    /// The same one terminal output uses, which is why it is set from outside:
    /// it is created with the listener, after this state exists. Anything the
    /// machine needs to say to whoever is watching, rather than to whoever
    /// asked, goes through here.
    pub fanout: std::sync::OnceLock<broadcast::Sender<ServerFrame>>,
    /// What each provider answered when asked for its models. See `discover`.
    models: RwLock<std::collections::HashMap<String, Discovery>>,
    /// Raised when a local client asks the daemon to stop.
    ///
    /// Signals are the natural way to say this and Windows has no equivalent
    /// that reaches a windowless child, so the desktop shell there would have
    /// to kill the process and skip every bit of cleanup. Asking over the same
    /// loopback connection it already uses works the same everywhere.
    pub shutdown: Arc<tokio::sync::Notify>,
}

pub type Shared = Arc<AppState>;

/// One provider's answer, and what it was asked.
#[derive(Clone)]
struct Discovery {
    /// The key, address and dialect this answer belongs to.
    question: String,
    models: Vec<String>,
    problem: Option<String>,
    at: std::time::Instant,
}

impl Discovery {
    fn still_current(&self) -> bool {
        // A list that came back is kept for as long as the process lives; a
        // failure is retried after a minute. Providers do not add models while
        // someone is looking at the picker, but keys get pasted correctly on the
        // second try.
        self.problem.is_none() || self.at.elapsed() < std::time::Duration::from_secs(60)
    }
}

/// What a provider is asked, in one string, so a change to any part of it
/// invalidates the answer without anything having to remember to.
fn question_for(id: &str, config: &ProviderConfig) -> String {
    let resolved = crate::provider::resolve(id, config);
    format!(
        "{}|{}|{}",
        resolved.base_url.unwrap_or_default(),
        resolved.dialect.as_str(),
        config.api_key.clone().unwrap_or_default(),
    )
}

async fn config_lan(config: &Arc<RwLock<Config>>) -> bool {
    config.read().await.lan_enabled
}

impl AppState {
    pub async fn build(paths: Paths) -> Result<(Shared, mpsc::UnboundedReceiver<PtyMessage>)> {
        paths.ensure()?;
        let config = Config::load(&paths.config_file())?;
        let machine = MachineState::load_or_create(&paths.state_file())?;
        let devices = Devices::load(paths.devices_file());

        let registry = Arc::new(Registry::new(&config.agents.custom));
        let store = Store::new(paths.sessions_dir());
        let sessions = SessionManager::new(store, registry.clone(), config.replay_window);

        let config = Arc::new(RwLock::new(config));
        let workspaces = Workspaces::new(config.clone(), paths.config_file());
        workspaces.load().await;
        if let Some(root) = paths.default_workspace.clone() {
            // A home directory that cannot be written to is unusual but not
            // fatal: the user can still open a folder by hand, and refusing to
            // start would take that from them too.
            if let Err(error) = workspaces.ensure_default(&root).await {
                tracing::warn!(%error, "no default workspace");
            }
        }

        let (terminals, pty_rx) = Terminals::new();
        let updates_dir = paths.updates_dir();

        let state = Arc::new(AppState {
            paths,
            config,
            machine,
            registry,
            sessions,
            workspaces,
            terminals,
            version: env!("CARGO_PKG_VERSION").to_string(),
            token: uuid::Uuid::new_v4().simple().to_string(),
            devices,
            link: std::sync::OnceLock::new(),
            remote: std::sync::OnceLock::new(),
            updates: crate::updates::Downloader::new(updates_dir),
            fanout: std::sync::OnceLock::new(),
            models: RwLock::new(std::collections::HashMap::new()),
            shutdown: Arc::new(tokio::sync::Notify::new()),
        });
        Ok((state, pty_rx))
    }

    /// Providers as everything downstream should see them: address filled in,
    /// models known.
    ///
    /// Resolved here rather than by each adapter and by the agent, because that
    /// is how a DeepSeek key ended up at OpenAI — three places deciding what a
    /// missing address means, one of them by falling back to a vendor URL. What
    /// comes out of here either has an address or has no models, and an adapter
    /// never has to guess.
    pub async fn providers(&self) -> ProviderMap {
        let stored = self.config.read().await.agents.providers.clone();
        let discovered = self.discover(&stored).await;
        stored
            .into_iter()
            .map(|(id, config)| {
                let resolved = crate::provider::resolve(&id, &config);
                let models = if config.models.is_empty() {
                    discovered
                        .get(&id)
                        .map(|found| found.models.clone())
                        .unwrap_or_default()
                } else {
                    config.models.clone()
                };
                let problem = if config.models.is_empty() {
                    discovered.get(&id).and_then(|found| found.problem.clone())
                } else {
                    None
                };
                (
                    id,
                    ProviderConfig {
                        base_url: resolved.base_url,
                        label: Some(resolved.label),
                        dialect: Some(resolved.dialect.as_str().to_string()),
                        models,
                        problem,
                        ..config
                    },
                )
            })
            .collect()
    }

    pub async fn settings(&self) -> Settings {
        let stored = self.config.read().await.agents.providers.clone();
        let discovered = self.discover(&stored).await;
        Settings {
            providers: stored
                .iter()
                .map(|(id, provider)| {
                    let resolved = crate::provider::resolve(id, provider);
                    let found = discovered.get(id);
                    ProviderInfo {
                        id: id.clone(),
                        has_api_key: provider
                            .api_key
                            .as_deref()
                            .is_some_and(|key| !key.is_empty()),
                        base_url: resolved.base_url,
                        label: resolved.label,
                        dialect: resolved.dialect.as_str().to_string(),
                        custom: resolved.custom,
                        models: if provider.models.is_empty() {
                            found.map(|f| f.models.clone()).unwrap_or_default()
                        } else {
                            provider.models.clone()
                        },
                        problem: if provider.models.is_empty() {
                            found.and_then(|f| f.problem.clone())
                        } else {
                            None
                        },
                    }
                })
                .collect(),
            lan_enabled: config_lan(&self.config).await,
        }
    }

    /// Asks every configured provider for its models, once per set of details.
    ///
    /// Cached against the key, address and dialect it was asked with, so editing
    /// any of them asks again and nothing else does. That is also why there is no
    /// "refresh" button and no expiry to tune: the answer only changes when the
    /// question does, or when the provider adds a model — and for that, restart.
    ///
    /// A failure is cached too, for a minute. Otherwise a rejected key means
    /// every settings page load and every session start pays a timeout again.
    async fn discover(&self, stored: &ProviderMap) -> std::collections::HashMap<String, Discovery> {
        let mut asking = Vec::new();
        {
            let cache = self.models.read().await;
            for (id, config) in stored {
                if !config.models.is_empty() {
                    continue;
                }
                let question = question_for(id, config);
                match cache.get(id) {
                    Some(found) if found.question == question && found.still_current() => {}
                    _ => asking.push((id.clone(), config.clone(), question)),
                }
            }
        }

        // Concurrently: a page with three keys on it should wait as long as the
        // slowest provider, not as long as all of them added up.
        let answers = futures_util::future::join_all(asking.into_iter().map(
            |(id, config, question)| async move {
                let answer = crate::provider::list_models(&id, &config).await;
                let discovery = match answer {
                    Ok(models) => Discovery {
                        question,
                        models,
                        problem: None,
                        at: std::time::Instant::now(),
                    },
                    Err(error) => Discovery {
                        question,
                        models: Vec::new(),
                        problem: Some(format!("{error:#}")),
                        at: std::time::Instant::now(),
                    },
                };
                (id, discovery)
            },
        ))
        .await;

        let mut cache = self.models.write().await;
        for (id, discovery) in answers {
            cache.insert(id, discovery);
        }
        cache.clone()
    }

    /// Stores a provider credential and persists it.
    ///
    /// An empty key clears the entry rather than storing a blank one: a stored
    /// empty string would read as "configured" everywhere and fail only at the
    /// moment the user runs a task.
    pub async fn set_provider(
        &self,
        provider_id: &str,
        api_key: Option<String>,
        base_url: Option<String>,
        label: Option<String>,
        dialect: Option<String>,
        models: Option<Vec<String>>,
    ) -> Result<Settings> {
        {
            let mut config = self.config.write().await;
            let entry = config
                .agents
                .providers
                .entry(provider_id.to_string())
                .or_default();
            if let Some(key) = api_key {
                entry.api_key = (!key.is_empty()).then_some(key);
            }
            if let Some(url) = base_url {
                entry.base_url = (!url.is_empty()).then_some(url);
            }
            if let Some(label) = label {
                entry.label = (!label.is_empty()).then_some(label);
            }
            if let Some(dialect) = dialect {
                entry.dialect = (!dialect.is_empty()).then_some(dialect);
            }
            if let Some(models) = models {
                entry.models = models.into_iter().filter(|m| !m.is_empty()).collect();
            }
            config.save(&self.paths.config_file())?;
        }
        crate::config::restrict_to_owner(&self.paths.config_file())?;
        // The settings that come back are asked again with the new details,
        // which is what puts the models on screen right after saving a key.
        Ok(self.settings().await)
    }

    /// Drops a provider entirely. Only ones the user added: removing `deepseek`
    /// would leave a row that comes back on the next start, which reads as a bug.
    pub async fn forget_provider(&self, provider_id: &str) -> Result<Settings> {
        {
            let mut config = self.config.write().await;
            let Some(entry) = config.agents.providers.get(provider_id) else {
                return Ok(self.settings().await);
            };
            if !crate::provider::resolve(provider_id, entry).custom {
                return Err(anyhow::anyhow!("{provider_id} 是内置的，只能清空它的 Key"));
            }
            config.agents.providers.remove(provider_id);
            config.save(&self.paths.config_file())?;
        }
        self.models.write().await.remove(provider_id);
        Ok(self.settings().await)
    }

    /// Publishes the loopback address and token for same-machine clients.
    ///
    /// A file rather than a fixed port because the port is chosen at startup,
    /// and a fixed one collides the moment a second instance or another app
    /// wants it.
    pub fn publish_endpoint(&self, port: u16) -> Result<PathBuf> {
        let path = self.paths.endpoint_file();
        let body = serde_json::json!({
            "port": port,
            "token": self.token,
            "machineId": self.machine.machine_id,
            "fingerprint": self.machine.fingerprint(),
            "pid": std::process::id(),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&body)?)?;
        crate::config::restrict_to_owner(&path)?;
        Ok(path)
    }

    /// Says something to every client that happens to be connected.
    ///
    /// Dropped silently when nobody is listening, which is the ordinary case for
    /// a daemon nobody has open. What this carries is a state the client can ask
    /// for again (`update.downloadState`), so a missed frame costs a stale
    /// screen until the next one, never a lost fact.
    pub fn push(&self, frame: ServerFrame) {
        if let Some(fanout) = self.fanout.get() {
            let _ = fanout.send(frame);
        }
    }
}
