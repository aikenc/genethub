//! genet-daemon — the one resident process on a user's machine.

use std::fs;
use std::io::Write;

use anyhow::{Context, Result};
use genet_daemon::config::Paths;
use genet_daemon::Daemon;

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("GENEHUB_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();

    let paths = Paths::discover()?;
    paths.ensure()?;
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
        if let Ok(contents) = fs::read_to_string(&path) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                if is_running(pid) {
                    anyhow::bail!("another daemon is already running (pid {pid}); stop it first");
                }
                // A stale lock from a crash should not block startup forever.
                tracing::warn!("clearing a stale lock from pid {pid}");
            }
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

#[cfg(unix)]
fn is_running(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
        || unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, signal: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, signal)
}

#[cfg(not(unix))]
fn is_running(_pid: u32) -> bool {
    // Without a cheap probe, assume the lock is stale rather than refusing to
    // start: a daemon that will not launch is worse than a rare double start.
    false
}
