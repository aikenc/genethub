//! Minimal native process state.
//!
//! Product state lives in the signed Wasm application. Native state is limited
//! to platform bootstrap, machine credentials, transports and VM ownership.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use tokio::sync::{broadcast, Mutex, RwLock};

use crate::config::{Config, MachineState, Paths};
use crate::link::SharedLink;
use crate::remote::SharedRemote;

pub struct AppState {
    pub paths: Paths,
    /// Native startup reads only `port` and `lan_enabled`. The remaining legacy
    /// fields are copied once into the guest's private store and ignored here.
    pub config: Arc<RwLock<Config>>,
    pub machine: MachineState,
    /// Serializes read-modify-write of enrollment and rendezvous credentials.
    machine_state_write: Mutex<()>,
    pub version: String,
    /// Owner-only secret used to mint short-lived loopback admission proofs.
    pub token: String,
    pub link: std::sync::OnceLock<SharedLink>,
    pub remote: std::sync::OnceLock<SharedRemote>,
    /// `None` exists only in unit-test process scaffolding. A real Daemon start
    /// fails closed unless a verified signed application is active.
    pub logic: Option<Arc<crate::logic::LogicHost>>,
    /// Signed-application discovery and activation. Its URLs come only from
    /// channel-stamped App constants, never from a Web request.
    pub patch: Arc<crate::patch::PatchService>,
    /// Native transport/runtime diagnostics contain categorical platform
    /// facts only; product routing decides whether they are returned.
    pub diagnostics: Arc<crate::diagnostics::Diagnostics>,
    /// Resident audio/runtime resources. Speech settings and context policy
    /// are supplied by the portable application.
    pub speech: Arc<crate::speech::SpeechBroker>,
    pub fanout: std::sync::OnceLock<broadcast::Sender<crate::logic::RoutedEvent>>,
    pub shutdown: Arc<tokio::sync::Notify>,
}

pub type Shared = Arc<AppState>;

impl AppState {
    pub async fn build(paths: Paths) -> Result<Shared> {
        paths.ensure()?;
        let config = Arc::new(RwLock::new(Config::load(&paths.config_file())?));
        let machine = MachineState::load_or_create(&paths.state_file())?;
        let version = env!("CARGO_PKG_VERSION").to_string();
        let logic = crate::logic::LogicHost::discover(&paths, &machine, &version)?;
        let patch = Arc::new(crate::patch::PatchService::new(
            crate::patch::PatchConfig::stamped(),
        )?);
        let state = Arc::new(Self {
            paths,
            config,
            machine,
            machine_state_write: Mutex::new(()),
            version,
            token: uuid::Uuid::new_v4().simple().to_string(),
            link: std::sync::OnceLock::new(),
            remote: std::sync::OnceLock::new(),
            logic,
            patch,
            diagnostics: Arc::new(crate::diagnostics::Diagnostics::new()),
            speech: Arc::new(crate::speech::SpeechBroker::new()),
            fanout: std::sync::OnceLock::new(),
            shutdown: Arc::new(tokio::sync::Notify::new()),
        });
        if let Some(logic) = state.logic.as_ref() {
            logic.attach_state(&state)?;
        }
        Ok(state)
    }

    pub(crate) async fn mutate_machine_state<T>(
        &self,
        mutate: impl FnOnce(&mut MachineState) -> Result<T>,
    ) -> Result<T> {
        let _guard = self.machine_state_write.lock().await;
        let path = self.paths.state_file();
        let mut machine = MachineState::load(&path)?;
        let result = mutate(&mut machine)?;
        machine.save(&path)?;
        Ok(result)
    }

    pub fn publish_endpoint(&self, port: u16) -> Result<PathBuf> {
        let path = self.paths.endpoint_file();
        let body = serde_json::json!({
            "port": port,
            "token": self.token,
            "machineId": self.machine.machine_id,
            "fingerprint": self.machine.fingerprint(),
            "pid": std::process::id(),
        });
        crate::config::save_private(&path, serde_json::to_string_pretty(&body)?.as_bytes())?;
        Ok(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Enrollment, Rendezvous};

    #[tokio::test]
    async fn independent_machine_state_updates_merge_instead_of_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path().to_path_buf());
        let state_path = paths.state_file();
        let state = AppState::build(paths).await.unwrap();
        let enrollment = Enrollment {
            hub_url: "https://hub.example".into(),
            machine_id: "mch_test".into(),
            daemon_id: "dmn_test".into(),
            secret: "secret".into(),
            workspace_catalog_generation: Some("wcg_test".into()),
        };
        let rendezvous = Rendezvous {
            relay_url: "https://self-hosted.example".into(),
            join_token: Some("join".into()),
        };
        let (hub, remote) = tokio::join!(
            state.mutate_machine_state(|machine| {
                machine.enrollment = Some(enrollment);
                Ok(())
            }),
            state.mutate_machine_state(|machine| {
                machine.rendezvous = Some(rendezvous);
                Ok(())
            }),
        );
        hub.unwrap();
        remote.unwrap();
        let persisted = MachineState::load(&state_path).unwrap();
        assert!(persisted.enrollment.is_some());
        assert!(persisted.rendezvous.is_some());
    }
}
