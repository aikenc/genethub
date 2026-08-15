//! The GeneHub daemon.
//!
//! Exposed as a library as well as a binary so integration tests can start a
//! real daemon in-process instead of asserting against a mock of one.

pub mod authz;
pub mod channel;
pub mod channel_auth;
pub mod config;
pub mod dataplane;
pub mod diagnostics;
pub mod files;
pub mod hub;
pub use genet_daemon_system::isolation;
pub mod lifecycle;
pub mod link;
pub mod logic;
pub mod logs;
pub mod process;
pub mod remote;
pub mod router;
pub mod run;
pub mod speech;
pub mod state;
pub mod transport;

use anyhow::Result;

pub use state::{AppState, Shared};

/// A running daemon.
pub struct Daemon {
    pub state: Shared,
    pub port: u16,
    listener: tokio::task::JoinHandle<()>,
}

impl Daemon {
    pub async fn start(paths: config::Paths) -> Result<Self> {
        let state = AppState::build(paths).await?;
        if state.logic.is_none() {
            #[cfg(not(test))]
            anyhow::bail!("no verified daemon logic artifact is active");
        }
        let pty = transport::local::pty_fanout();
        // The same channel every client already listens on, handed to the state
        // so anything the machine wants to volunteer — download progress, for
        // one — reaches them without a second bus to subscribe to.
        let _ = state.fanout.set(pty.clone());
        if let Some(logic) = state.logic.as_ref() {
            logic.start_event_pump(pty.clone()).await?;
        }
        let listener = transport::local::serve(state.clone(), pty.clone()).await?;
        state.publish_endpoint(listener.port)?;

        let mut link = link::Link::new(state.paths.clone(), pty.clone());
        link.attach(&state).await;
        let _ = state.link.set(link);

        let mut remote = remote::Remote::new(state.paths.clone(), pty);
        remote.attach(&state).await;
        let _ = state.remote.set(remote);

        Ok(Daemon {
            state,
            port: listener.port,
            listener: listener.handle,
        })
    }

    pub fn websocket_url(&self) -> String {
        self.websocket_admission().url
    }

    pub fn websocket_admission(&self) -> transport::local::LocalWebSocketAdmission {
        transport::local::websocket_admission(
            self.port,
            &self.state.token,
            std::process::id(),
            &self.state.machine.machine_id,
            &self.state.machine.fingerprint(),
        )
    }

    /// Stops accepting connections and tears down every child process.
    ///
    /// Ordering matters: sessions first, so agents get their shutdown before
    /// the runtime goes away and leaves them orphaned.
    pub async fn shutdown(self) {
        if let Some(link) = self.state.link.get() {
            link.stop().await;
        }
        if let Some(remote) = self.state.remote.get() {
            remote.stop().await;
        }
        if let Some(logic) = self.state.logic.as_ref() {
            logic.shutdown().await;
        }
        self.listener.abort();
        let _ = std::fs::remove_file(self.state.paths.endpoint_file());
    }
}
