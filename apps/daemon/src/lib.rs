//! The GeneHub daemon.
//!
//! Exposed as a library as well as a binary so integration tests can start a
//! real daemon in-process instead of asserting against a mock of one.

pub mod adapter;
pub mod config;
pub mod files;
pub mod git;
pub mod hub;
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
    uplink: Option<transport::uplink::Uplink>,
}

impl Daemon {
    pub async fn start(paths: config::Paths) -> Result<Self> {
        let (state, pty_rx) = AppState::build(paths).await?;
        let pty = transport::local::pty_fanout(pty_rx);
        let listener = transport::local::serve(state.clone(), pty.clone()).await?;
        state.publish_endpoint(listener.port)?;

        // Enrolled machines dial the Hub so they stay reachable from outside;
        // an unenrolled one is simply a local-only daemon, which is a perfectly
        // good way to use the product.
        let uplink = state.machine.enrollment.as_ref().map(|enrollment| {
            transport::uplink::Uplink::start(
                state.clone(),
                pty,
                enrollment.uplink_url.clone(),
                enrollment.ticket(),
            )
        });

        Ok(Daemon {
            state,
            port: listener.port,
            listener: listener.handle,
            uplink,
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
        if let Some(uplink) = self.uplink {
            uplink.stop();
        }
        self.listener.abort();
        let _ = std::fs::remove_file(self.state.paths.endpoint_file());
    }
}
