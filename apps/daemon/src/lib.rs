//! The GeneHub daemon.
//!
//! Exposed as a library as well as a binary so integration tests can start a
//! real daemon in-process instead of asserting against a mock of one.

pub mod adapter;
pub mod config;
pub mod files;
pub mod git;
pub mod pty;
pub mod router;
pub mod session;
pub mod state;
pub mod transport;
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
        let listener = transport::local::serve(state.clone(), pty_rx).await?;
        state.publish_endpoint(listener.port)?;
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
        self.listener.abort();
        let _ = std::fs::remove_file(self.state.paths.endpoint_file());
    }
}
