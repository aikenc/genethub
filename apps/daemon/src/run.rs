//! The daemon's foreground entry point — what `genet daemon run` executes.
//!
//! This lived in `apps/daemon/src/main.rs` while the daemon was its own
//! binary. The merge (`genethub-cli.md` §2) made the daemon a mode of the
//! `genet` binary rather than a file of its own, so the logic moved here for
//! the CLI's dispatcher to call.

use std::fs;
use std::io::{Seek, Write};

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
    println!("{}", listening_payload(&daemon));
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

fn listening_payload(daemon: &Daemon) -> serde_json::Value {
    let admission = daemon.websocket_admission();
    serde_json::json!({
        "event": "listening",
        "port": daemon.port,
        "url": admission.url,
        "serverProof": admission.server_proof,
        "admission": {
            "challenge": admission.challenge,
            "pid": admission.pid,
            "machineId": admission.machine_id,
            "fingerprint": admission.fingerprint,
            "expiresAt": admission.expires_at,
        },
        "pid": std::process::id(),
        "machineId": daemon.state.machine.machine_id,
        "fingerprint": daemon.state.machine.fingerprint(),
    })
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
    file: Option<std::fs::File>,
}

impl SingleInstance {
    fn acquire(paths: &Paths) -> Result<Self> {
        let path = paths.lock_file();
        let mut options = fs::OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        crate::config::restrict_to_owner(&path)?;
        if let Err(error) = fs2::FileExt::try_lock_exclusive(&file) {
            let owner = crate::lifecycle::lock_pid(paths)
                .map(|pid| format!(" (pid {pid})"))
                .unwrap_or_default();
            if error.kind() == std::io::ErrorKind::WouldBlock {
                anyhow::bail!("another daemon is already running{owner}; stop it first");
            }
            return Err(error).with_context(|| format!("locking {}", path.display()));
        }
        // File contents are for human/CLI diagnostics only. The kernel-held
        // lock is the authority: it is released on crash and cannot suffer pid
        // reuse or the check-then-write race of the former pid probe.
        file.set_len(0)?;
        file.rewind()?;
        write!(file, "{}", std::process::id())?;
        file.sync_all()?;
        Ok(SingleInstance { file: Some(file) })
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = fs2::FileExt::unlock(&file);
            drop(file);
        }
        // Keep the inode permanently. Unlinking after unlock lets another
        // process lock the old inode while a third creates and locks a new file
        // at the same path, producing two live daemons.
    }
}

#[cfg(test)]
mod instance_tests {
    use super::*;

    #[test]
    fn the_kernel_lock_blocks_a_racing_second_daemon_but_not_a_stale_live_pid() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        paths.ensure().unwrap();

        let first = SingleInstance::acquire(&paths).unwrap();
        assert!(SingleInstance::acquire(&paths).is_err());
        #[cfg(unix)]
        let inode = {
            use std::os::unix::fs::MetadataExt;
            std::fs::metadata(paths.lock_file()).unwrap().ino()
        };
        drop(first);
        assert!(paths.lock_file().exists());

        // A crash can leave text behind, and that pid may now name an entirely
        // different live process. With the kernel lock released, it must not
        // block recovery or authorize killing that process.
        std::fs::write(paths.lock_file(), std::process::id().to_string()).unwrap();
        let recovered = SingleInstance::acquire(&paths).unwrap();
        assert!(SingleInstance::acquire(&paths).is_err());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(std::fs::metadata(paths.lock_file()).unwrap().ino(), inode);
        }
        drop(recovered);
    }

    #[tokio::test]
    async fn the_listening_line_never_publishes_the_reusable_local_secret() {
        let dir = tempfile::tempdir().unwrap();
        let daemon = Daemon::start(Paths::new(dir.path())).await.unwrap();
        let secret = daemon.state.token.clone();
        let payload = listening_payload(&daemon);
        let text = payload.to_string();

        assert_eq!(payload["event"], "listening");
        assert!(payload["url"].as_str().unwrap().contains("proof="));
        assert!(!payload["url"]
            .as_str()
            .unwrap()
            .contains(payload["serverProof"].as_str().unwrap()));
        assert_eq!(payload["admission"]["machineId"], payload["machineId"]);
        assert!(payload.get("token").is_none());
        assert!(!text.contains(&secret));
        assert!(!text.contains("token="));

        daemon.shutdown().await;
    }
}
