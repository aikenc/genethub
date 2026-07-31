//! genet-daemon — the one resident process on a user's machine.

use std::fs;
use std::io::Write;

use anyhow::{Context, Result};
use genet_daemon::config::Paths;
use genet_daemon::Daemon;

#[tokio::main]
async fn main() -> Result<()> {
    // Answered before anything touches the disk: "which build is this" is a
    // question asked of a machine that is already misbehaving, and the answer
    // should not depend on a data directory being readable — or on a locked one
    // belonging to the daemon that is already running.
    //
    // The release workflow asks it too, to prove the version it stamped into the
    // manifests is the version the shipped binary reports (`scripts/version.sh`).
    if std::env::args().any(|argument| argument == "--version" || argument == "-V") {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }

    // The data directory has to be known before logging starts, because the log
    // goes in it. Anything that fails in between is on stderr, which the desktop
    // shell keeps in the same directory.
    let paths = Paths::discover()?;
    paths.ensure()?;

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env(genet_daemon::channel::ENV_LOG)
                .unwrap_or_else(|_| "info".into()),
        )
        .with_writer(Tee::new(genet_daemon::logs::LogFile::open(
            paths.log_file(),
        )))
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
    file: genet_daemon::logs::LogFile,
    watched: bool,
}

impl Tee {
    fn new(file: genet_daemon::logs::LogFile) -> Self {
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
