//! The GeneHub daemon.
//!
//! Exposed as a library as well as a binary so integration tests can start a
//! real daemon in-process instead of asserting against a mock of one.

pub mod adapter;
pub mod channel;
pub mod config;
pub mod devices;
pub mod files;
pub mod git;
pub mod hub;
pub mod lifecycle;
pub mod link;
pub mod logs;
pub mod provider;
pub mod pty;
pub mod remote;
pub mod router;
pub mod run;
pub mod session;
pub mod state;
pub mod transport;
pub mod updates;
pub mod workspace;

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
        let (state, pty_rx) = AppState::build(paths).await?;
        let pty = transport::local::pty_fanout(pty_rx);
        // The same channel every client already listens on, handed to the state
        // so anything the machine wants to volunteer — download progress, for
        // one — reaches them without a second bus to subscribe to.
        let _ = state.fanout.set(pty.clone());
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

    pub fn token(&self) -> &str {
        &self.state.token
    }

    pub fn websocket_url(&self) -> String {
        transport::local::websocket_url(self.port, &self.state.token)
    }

    /// Stops accepting connections and tears down every child process.
    ///
    /// Ordering matters: sessions first, so agents get their shutdown before
    /// the runtime goes away and leaves them orphaned.
    pub async fn shutdown(self) {
        self.state.sessions.shutdown().await;
        self.state.terminals.close_all().await;
        if let Some(link) = self.state.link.get() {
            link.stop().await;
        }
        if let Some(remote) = self.state.remote.get() {
            remote.stop().await;
        }
        self.listener.abort();
        let _ = std::fs::remove_file(self.state.paths.endpoint_file());
    }
}
