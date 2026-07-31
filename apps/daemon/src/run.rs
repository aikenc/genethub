//! The daemon's foreground entry point — what `genet daemon run` executes.
//!
//! This lived in `apps/daemon/src/main.rs` while the daemon was its own
//! binary. The merge (`genethub-cli.md` §2) made the daemon a mode of the
//! `genet` binary rather than a file of its own, so the logic moved here for
//! the CLI's dispatcher to call.

use std::fs;
use std::io::Write;

use anyhow::{Context, Result};

use crate::config::Paths;
use crate::Daemon;

/// Runs the daemon in the foreground until a signal or a local client asks it
/// to stop. The listening line goes to stdout for whoever spawned us — the
/// desktop shell reads it to learn the endpoint without racing the file write.
pub async fn run() -> Result<()> {
    // The data directory has to be known before logging starts, because the log
    // goes in it. Anything that fails in between is on stderr, which the desktop
    // shell keeps in the same directory.
    let paths = Paths::discover()?;
    paths.ensure()?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env(crate::channel::ENV_LOG)
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(Tee::new(crate::logs::LogFile::open(paths.log_file())))
        .init();
    tracing::info!("log: {}", paths.log_file().display());
    let _lock = SingleInstance::acquire(&paths)?;

    let daemon = Daemon::start(paths).await?;
    // Printed on stdout so the desktop shell can read the endpoint without
    // racing the file write.
    println!(
        "{}",
        serde_json::json!({
            "event": "listening",
            "port": daemon.port,
            "token": daemon.token(),
            "machineId": daemon.state.machine.machine_id,
            "fingerprint": daemon.state.machine.fingerprint(),
        })
    );
    let _ = std::io::stdout().flush();
    tracing::info!("listening on 127.0.0.1:{}", daemon.port);

    let asked = daemon.state.shutdown.clone();
    tokio::select! {
        _ = wait_for_signal() => {}
        _ = asked.notified() => tracing::info!("a local client asked us to stop"),
    }
    tracing::info!("shutting down");
    daemon.shutdown().await;
    Ok(())
}

/// Writes to the log file, and to stderr when someone is watching it.
///
/// The file is the destination that matters: it is what a client on another
/// device can be handed (`log.tail`), and what survives the process.
///
/// stderr is added only when it is a terminal, i.e. when a person ran this and is
/// reading along. When it is a pipe, the far end is the desktop shell or a service
/// manager, which is already keeping the file — and writing both would put two
/// copies of every line in the same directory.
#[derive(Clone)]
struct Tee {
    file: crate::logs::LogFile,
    watched: bool,
}

impl Tee {
    fn new(file: crate::logs::LogFile) -> Self {
        use std::io::IsTerminal;
        Tee {
            file,
            watched: std::io::stderr().is_terminal(),
        }
    }
}

impl Write for Tee {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        if self.watched {
            // Ignored on purpose: a stderr that has gone away must not stop the
            // file from being written.
            let _ = std::io::stderr().write_all(buf);
        }
        self.file.write(buf)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        if self.watched {
            let _ = std::io::stderr().flush();
        }
        self.file.flush()
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for Tee {
    type Writer = Tee;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// A lock file holding the current pid.
///
/// Two daemons on one data directory would fight over session files and both
/// publish an endpoint, leaving clients connecting to whichever won the race.
struct SingleInstance {
    path: std::path::PathBuf,
}

impl SingleInstance {
    fn acquire(paths: &Paths) -> Result<Self> {
        let path = paths.lock_file();
        if let Some(pid) = crate::lifecycle::lock_pid(paths) {
            if crate::lifecycle::pid_alive(pid) {
                anyhow::bail!("another daemon is already running (pid {pid}); stop it first");
            }
            // A stale lock from a crash should not block startup forever.
            tracing::warn!("clearing a stale lock from pid {pid}");
        }
        fs::write(&path, std::process::id().to_string())
            .with_context(|| format!("writing {}", path.display()))?;
        Ok(SingleInstance { path })
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}
