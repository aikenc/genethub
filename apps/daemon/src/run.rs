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

/// Why the foreground run ended. `Reload` is the guest asking its shell to
/// re-read the component and instantiate it again in the same process — the
/// in-place update path (`wasm-v2-resident-shell.md`).
pub enum Exit {
    Shutdown,
    Reload,
}

/// Runs the daemon in the foreground until a signal or a local client asks it
/// to stop. The listening line goes to stdout for whoever spawned us — the
/// desktop shell reads it to learn the endpoint without racing the file write.
pub async fn run() -> Result<Exit> {
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
    // A previous host that trapped or was killed has already dropped the
    // kernel lock. Reclaim the files it left so this start is not talking
    // to a dead port or compiling a half-written cache.
    if let Err(error) = crate::lifecycle::reap_stale_runtime(&paths) {
        tracing::warn!(%error, "could not reclaim leftover runtime files");
    }

    tracing::info!("log: {}", paths.log_file().display());
    tracing::info!(
        event = "daemon_started",
        version = env!("CARGO_PKG_VERSION"),
        channel = crate::channel::PRODUCT,
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
        pid = crate::host_pid::current(),
        "daemon diagnostic context"
    );
    let _lock = SingleInstance::acquire(&paths)?;

    let daemon = Daemon::start(paths).await?;
    // Printed on stdout so the desktop shell can read the endpoint without
    // racing the file write.
    println!("{}", listening_payload(&daemon));
    let _ = std::io::stdout().flush();
    tracing::info!("listening on 127.0.0.1:{}", daemon.port);

    let asked = daemon.state.shutdown.clone();
    let reload = daemon.state.reload.clone();
    let component_changed = component_watcher();
    tokio::select! {
        _ = wait_for_signal() => {}
        _ = asked.notified() => tracing::info!("a local client asked us to stop"),
        _ = reload.notified() => {
            tracing::info!("a signed guest update was applied; reloading in place");
            daemon.shutdown().await;
            return Ok(Exit::Reload);
        }
        // The component file we were loaded from changed on disk: a dev
        // rebuild landed, or an installer replaced us. Hand the process back
        // to the shell, which re-reads the artifact and instantiates it again
        // in this same pid.
        _ = component_changed => {
            tracing::info!("the guest component changed on disk; reloading in place");
            daemon.shutdown().await;
            return Ok(Exit::Reload);
        }
    }
    tracing::info!("shutting down");
    daemon.shutdown().await;
    Ok(Exit::Shutdown)
}

/// Fires when the component file the shell loaded changes. Pending forever
/// when there is nothing to watch: a native run has no component, and a guest
/// whose shell did not name one cannot be reloaded anyway.
///
/// mtime+len, not a hash: the point is to notice a replaced artifact, and a
/// 26 MB component is not re-read every two seconds to do it. A write in
/// progress shows up as a missing file or a changing stamp and is waited out
/// rather than raced.
async fn component_watcher() {
    let path = match std::env::var(crate::channel::ENV_COMPONENT_FILE) {
        Ok(value) if !value.is_empty() => std::path::PathBuf::from(value),
        _ => {
            tracing::info!("no component file named by the shell; in-place reload is off");
            std::future::pending::<std::path::PathBuf>().await
        }
    };
    let stamp = |path: &std::path::Path| {
        std::fs::metadata(path)
            .ok()
            .and_then(|meta| meta.modified().ok().map(|mtime| (mtime, meta.len())))
    };
    let original = stamp(&path);
    tracing::info!(component = %path.display(), stamp = ?original, "watching the component file");
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(2));
    loop {
        interval.tick().await;
        let current = stamp(&path);
        match (original, current) {
            // Gone (a replace mid-flight) is not a change to act on.
            (_, None) => {}
            (Some(before), Some(now)) if now != before => return,
            (None, Some(_)) => return,
            _ => {}
        }
    }
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
        "pid": crate::host_pid::current(),
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
    #[cfg(all(unix, not(target_family = "wasm")))]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("SIGINT handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
        }
    }
    #[cfg(all(not(unix), not(target_family = "wasm")))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
    #[cfg(target_family = "wasm")]
    {
        std::future::pending::<()>().await;
    }
}

/// Truncates the lock file to the current pid. Shared by the native path
/// (where a failure is fatal) and the guest path (where a mandatory-lock
/// refusal is tolerated by the caller).
fn write_lock_pid(file: &mut std::fs::File) -> std::io::Result<()> {
    file.set_len(0)?;
    file.rewind()?;
    write!(file, "{}", crate::host_pid::current())?;
    file.sync_all()
}

/// A lock file holding the current pid.
///
/// Two daemons on one data directory would fight over session files and both
/// publish an endpoint, leaving clients connecting to whichever won the race.
struct SingleInstance {
    file: Option<std::fs::File>,
    path: std::path::PathBuf,
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
        if let Err(error) = crate::fs_lock::try_lock_exclusive(&file, &path) {
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
        //
        // On WASI the host holds the lock on a second handle. Windows
        // `LockFileEx` is mandatory, so `set_len` / `write` through the guest
        // fd fails there as a bare `I/O error (os error 29)`; that must not
        // abort first start, so the guest write is best-effort. Where the
        // lock is advisory (Unix) the write lands and the CLI can name the
        // daemon's pid; where it is refused the content stays empty and the
        // kernel lock remains the running signal.
        #[cfg(not(target_family = "wasm"))]
        write_lock_pid(&mut file)?;
        #[cfg(target_family = "wasm")]
        let _ = write_lock_pid(&mut file);
        Ok(SingleInstance {
            file: Some(file),
            path,
        })
    }
}

impl Drop for SingleInstance {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = crate::fs_lock::unlock(&file, &self.path);
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
        std::fs::write(paths.lock_file(), crate::host_pid::current().to_string()).unwrap();
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
