//! Process lifecycle facts shared by the daemon and the CLI that controls it.
//!
//! The daemon writes `daemon.lock` holding its pid when it starts; the CLI
//! reads the same file to answer "is it running" and to stop exactly that
//! process. Killing by binary name is not an option: the CLI and the daemon
//! are the same file (`genet`), so a name match would take every running
//! client down with the daemon (`genethub-cli.md` §2).

use std::fs;

use crate::config::Paths;

/// The pid in the lock file, if there is a readable one that parses.
pub fn lock_pid(paths: &Paths) -> Option<u32> {
    fs::read_to_string(paths.lock_file())
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Whether a refused `try_lock` means somebody else holds it, rather than
/// something being wrong with the file.
///
/// `ErrorKind::WouldBlock` alone is not the test. Windows reports contention as
/// `ERROR_LOCK_VIOLATION`, which maps to no kind at all, so a build that checks
/// only the kind reads "another process has this" as "this file is broken" —
/// exactly backwards, and only on the platform nobody develops on.
pub fn lock_contended(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::WouldBlock
        || (error.raw_os_error().is_some()
            && error.raw_os_error() == crate::fs_lock::lock_contended_error().raw_os_error())
}

/// After a crash the kernel has released the lock, but `endpoint.json` and
/// half-written wasm-cache files can still send the next start at a dead
/// port or a poison compile. Only reclaim when nobody holds the lock.
pub fn reap_stale_runtime(paths: &Paths) -> std::io::Result<()> {
    if instance_locked(paths)? {
        return Ok(());
    }
    let endpoint = paths.endpoint_file();
    if endpoint.exists() {
        let _ = fs::remove_file(&endpoint);
    }
    reap_wasm_cache_temporaries(&paths.root.join("wasm-cache"));
    Ok(())
}

/// Host write-then-rename leaves `.{pid}-{hash}.cwasm` after a kill.
pub fn leftover_wasm_cache_name(name: &str) -> bool {
    name.starts_with('.') && name.ends_with(".cwasm")
}

fn reap_wasm_cache_temporaries(dir: &std::path::Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        if leftover_wasm_cache_name(&entry.file_name().to_string_lossy()) {
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Whether another process currently holds the daemon's kernel lock.
///
/// File contents are only diagnostics. Unlike a pid probe, the lock is
/// released by the OS on crash and cannot become true again through pid reuse.
pub fn instance_locked(paths: &Paths) -> std::io::Result<bool> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(paths.lock_file())
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error),
    };
    match crate::fs_lock::try_lock_exclusive(&file, paths.lock_file().as_path()) {
        Ok(()) => {
            let _ = crate::fs_lock::unlock(&file, paths.lock_file().as_path());
            Ok(false)
        }
        Err(error) if lock_contended(&error) => Ok(true),
        Err(error) => Err(error),
    }
}

/// Whether that pid belongs to a live process.
#[cfg(unix)]
pub fn pid_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
        || unsafe { libc_kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
pub fn pid_alive(pid: u32) -> bool {
    // The same probe the desktop shell uses: asking the OS to open the
    // process is the cheap "is it there" on Windows.
    let _ = pid;
    // Without a cheap probe in this crate, assume alive only when the
    // endpoint also answers — callers pair this with a health check, the
    // same way `daemon.rs` in the shell does.
    true
}

/// Asks the process to end (SIGTERM), giving it the chance to shut sessions
/// down the graceful way.
#[cfg(unix)]
pub fn terminate(pid: u32) {
    const SIGTERM: i32 = 15;
    unsafe {
        libc_kill(pid as i32, SIGTERM);
    }
}

/// The last word, for a daemon that did not go quietly.
#[cfg(unix)]
pub fn force_kill(pid: u32) {
    const SIGKILL: i32 = 9;
    unsafe {
        libc_kill(pid as i32, SIGKILL);
    }
}

#[cfg(not(unix))]
pub fn terminate(pid: u32) {
    // No signal reaches a windowless process on Windows; taskkill without /F
    // asks, which a console-less process ignores, so this is the force form.
    force_kill(pid);
}

#[cfg(not(unix))]
pub fn force_kill(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status();
}

#[cfg(unix)]
unsafe fn libc_kill(pid: i32, signal: i32) -> i32 {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    kill(pid, signal)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Paths;

    #[test]
    fn leftover_cache_names_are_the_write_rename_temporaries() {
        assert!(leftover_wasm_cache_name(".1234-abc.cwasm"));
        assert!(!leftover_wasm_cache_name("abc.cwasm"));
        assert!(!leftover_wasm_cache_name(".tmp"));
    }

    #[test]
    fn a_dead_lock_loses_its_endpoint_and_cache_temporaries() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        paths.ensure().unwrap();
        std::fs::write(paths.endpoint_file(), "{\"port\":1}").unwrap();
        let cache = dir.path().join("wasm-cache");
        std::fs::create_dir_all(&cache).unwrap();
        let leftover = cache.join(".9-dead.cwasm");
        let keep = cache.join("abc.cwasm");
        std::fs::write(&leftover, b"tmp").unwrap();
        std::fs::write(&keep, b"ok").unwrap();

        reap_stale_runtime(&paths).unwrap();

        assert!(!paths.endpoint_file().exists());
        assert!(!leftover.exists());
        assert!(keep.exists());
    }

    #[test]
    fn a_live_lock_keeps_the_published_endpoint() {
        let dir = tempfile::tempdir().unwrap();
        let paths = Paths::new(dir.path());
        paths.ensure().unwrap();
        let lock = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .open(paths.lock_file())
            .unwrap();
        crate::fs_lock::try_lock_exclusive(&lock, paths.lock_file().as_path()).unwrap();
        std::fs::write(paths.endpoint_file(), "{\"port\":1}").unwrap();

        reap_stale_runtime(&paths).unwrap();

        assert!(paths.endpoint_file().exists());
        drop(lock);
    }
}
