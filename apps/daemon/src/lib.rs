//! The GeneHub daemon.
//!
//! Exposed as a library as well as a binary so integration tests can start a
//! real daemon in-process instead of asserting against a mock of one.

pub mod adapter;
pub mod authz;
pub(crate) mod blocking;
pub mod channel_auth;
pub mod cli_front;
pub mod config;
pub mod dataplane;
pub mod devices;
pub mod diagnostics;
pub mod files;
pub(crate) mod fs_cap;
pub mod git;
pub mod host_pid;
pub(crate) mod host_update;
pub(crate) mod http;
pub mod hub;
pub mod isolation;
pub mod link;
pub(crate) mod os_process;

// The native front door owns the build identity, the on-disk layout, the
// daemon's own lock and the loopback control-plane proofs. Re-exported at the
// paths this crate has always used, so that being a component again is the only
// difference the rest of the code sees (`docs/cli-thin-forwarder.md` §6).
pub use genet_frontdoor::channel;
pub use genet_frontdoor::fs_lock;
pub use genet_frontdoor::lifecycle;

pub mod logs;
pub mod process;
pub mod processes;
pub mod provider;
pub mod pty;
pub mod remote;
pub mod router;
pub mod run;
pub mod session;
pub mod skills;
pub mod speech;
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
        state
            .diagnostics
            .record("daemon", "lifecycle", "started", None);
        let pty = transport::local::pty_fanout(pty_rx);
        // The same channel every client already listens on, handed to the state
        // so anything the machine wants to volunteer — download progress, for
        // one — reaches them without a second bus to subscribe to.
        let _ = state.fanout.set(pty.clone());
        state.processes.announce_to(pty.clone());
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

    pub fn websocket_admission(&self) -> genet_frontdoor::proof::LocalWebSocketAdmission {
        genet_frontdoor::proof::websocket_admission(
            self.port,
            &self.state.token,
            crate::host_pid::current(),
            &self.state.machine.machine_id,
            &self.state.machine.fingerprint(),
        )
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
