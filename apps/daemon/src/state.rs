//! Everything the request handlers share.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::{mpsc, RwLock};

use crate::adapter::registry::Registry;
use crate::adapter::ProviderMap;
use crate::config::{Config, MachineState, Paths};
use crate::pty::{PtyMessage, Terminals};
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
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub async fn build(paths: Paths) -> Result<(Shared, mpsc::UnboundedReceiver<PtyMessage>)> {
        paths.ensure()?;
        let config = Config::load(&paths.config_file())?;
        let machine = MachineState::load_or_create(&paths.state_file())?;

        let registry = Arc::new(Registry::new(&config.agents.custom));
        let store = Store::new(paths.sessions_dir());
        let sessions = SessionManager::new(store, registry.clone(), config.replay_window);

        let config = Arc::new(RwLock::new(config));
        let workspaces = Workspaces::new(config.clone(), paths.config_file());
        workspaces.load().await;

        let (terminals, pty_rx) = Terminals::new();

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
        });
        Ok((state, pty_rx))
    }

    pub async fn providers(&self) -> ProviderMap {
        self.config.read().await.agents.providers.clone()
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
}
