//! The log file, and reading it back.
//!
//! Written by the daemon itself rather than by whoever launched it, for one
//! reason: the person who needs it is often not sitting at the machine. A path
//! on someone's PC is no help on the phone they are holding, so the log has to
//! be something the daemon can hand over the same connection everything else
//! goes over (`log.tail`).
//!
//! It also has to exist at all. Until now agent stderr went to `tracing::debug!`
//! while the filter sat at `info`, which means the one line explaining why
//! Claude Code exited was thrown away by us, on purpose, before anyone could
//! read it. "Claude Code stopped unexpectedly." was the entire account of it.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(not(target_family = "wasm"))]
use cap_std::ambient_authority;
#[cfg(not(target_family = "wasm"))]
use cap_std::fs::Dir;

/// Rotate at four megabytes, keep one old file.
///
/// Enough that a long day of a chatty agent still holds this morning; small
/// enough that reading it, or attaching it to a bug report, stays reasonable.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

/// How much of the file `tail` returns by default. A screenful of context, not
/// the whole history: what matters is nearly always the end.
pub const DEFAULT_TAIL_BYTES: usize = 256 * 1024;

/// A log file that stays a bounded size.
#[derive(Clone)]
pub struct LogFile {
    path: PathBuf,
    file: Arc<Mutex<Option<std::fs::File>>>,
}

impl LogFile {
    pub fn open(path: PathBuf) -> Self {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let file = open_private_append(&path).ok();
        LogFile {
            path,
            file: Arc::new(Mutex::new(file)),
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn rotate(&self, file: &mut Option<std::fs::File>) -> std::io::Result<()> {
        // Close before replacement so Windows does not depend on the sharing
        // flags used when this handle was opened.
        *file = None;
        let previous = self.path.with_extension("log.1");
        match std::fs::symlink_metadata(&self.path) {
            Ok(_) => {
                crate::config::replace_private(&self.path, &previous).map_err(|error| {
                    std::io::Error::other(format!("rotating private log: {error:#}"))
                })?;
                crate::config::restrict_to_owner(&previous).map_err(|error| {
                    std::io::Error::other(format!("restricting rotated log: {error:#}"))
                })?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        *file = Some(open_private_append(&self.path)?);
        Ok(())
    }
}

fn open_private_append(path: &Path) -> std::io::Result<std::fs::File> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    // Correct legacy files too: creation mode does not change an existing
    // world-readable log left by an older build or permissive umask.
    crate::config::restrict_to_owner(path).map_err(|error| {
        std::io::Error::other(format!("restricting log permissions: {error:#}"))
    })?;
    Ok(file)
}

impl Write for LogFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let mut held = self.file.lock().expect("the log is never poisoned");
        if let Some(file) = held.as_mut() {
            if file.metadata().map(|meta| meta.len()).unwrap_or(0) > MAX_BYTES {
                self.rotate(&mut held)?;
            }
        }
        match held.as_mut() {
            Some(file) => file.write(buf),
            // Nowhere to write is not worth failing a request over: a daemon
            // that refuses to work because it cannot log is worse than a quiet
            // one. The same line is on stderr regardless.
            None => Ok(buf.len()),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let mut held = self.file.lock().expect("the log is never poisoned");
        match held.as_mut() {
            Some(file) => file.flush(),
            None => Ok(()),
        }
    }
}

/// Every log in the directory, newest first, with sizes.
///
/// The desktop shell writes its own files in here (`shell.log`, and whatever the
/// daemon said before it could log anything), so this lists what is there rather
/// than only what we wrote.
pub fn list(dir: &Path) -> Vec<(String, u64)> {
    #[cfg(not(target_family = "wasm"))]
    {
        let Ok(directory) = Dir::open_ambient_dir(dir, ambient_authority()) else {
            return Vec::new();
        };
        let Ok(entries) = directory.read_dir(".") else {
            return Vec::new();
        };
        let mut found: Vec<(String, u64, cap_std::time::SystemTime)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                Some((
                    name,
                    meta.len(),
                    meta.modified()
                        .unwrap_or(cap_std::time::SystemClock::UNIX_EPOCH),
                ))
            })
            .collect();
        found.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
        found
            .into_iter()
            .map(|(name, size, _)| (name, size))
            .collect()
    }
    #[cfg(target_family = "wasm")]
    {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut found: Vec<(String, u64, std::time::SystemTime)> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| {
                let meta = entry.metadata().ok()?;
                if !meta.is_file() {
                    return None;
                }
                Some((
                    entry.file_name().to_string_lossy().to_string(),
                    meta.len(),
                    meta.modified().unwrap_or(std::time::UNIX_EPOCH),
                ))
            })
            .collect();
        found.sort_by_key(|(_, _, modified)| std::cmp::Reverse(*modified));
        found
            .into_iter()
            .map(|(name, size, _)| (name, size))
            .collect()
    }
}

/// The end of one log file.
///
/// Reads from the end rather than the start: these files reach megabytes, and
/// the interesting part is always what happened last. A partial first line is
/// dropped, since half a line reads as corruption.
pub fn tail(dir: &Path, name: &str, bytes: usize) -> anyhow::Result<String> {
    // A name, not a path. Serving `../../.ssh/id_rsa` to anyone who can ask for
    // a log would turn a diagnostic into a way to read the disk.
    if name.is_empty() || Path::new(name).components().count() != 1 {
        anyhow::bail!("{name} 不是一个日志文件名");
    }
    #[cfg(not(target_family = "wasm"))]
    {
        let directory = Dir::open_ambient_dir(dir, ambient_authority())?;
        // Capability-relative open keeps a log-directory symlink from becoming a
        // read of an arbitrary host file, without a check/open race.
        let mut file = directory
            .open(name)
            .map(cap_std::fs::File::into_std)
            .map_err(|error| anyhow::anyhow!("打不开 {name}：{error}"))?;
        tail_from_file(&mut file, bytes)
    }
    #[cfg(target_family = "wasm")]
    {
        let path = dir.join(name);
        let mut file = std::fs::File::open(&path)
            .map_err(|error| anyhow::anyhow!("打不开 {name}：{error}"))?;
        tail_from_file(&mut file, bytes)
    }
}

fn tail_from_file(file: &mut std::fs::File, bytes: usize) -> anyhow::Result<String> {
    let size = file.metadata()?.len();
    let from = size.saturating_sub(bytes as u64);
    file.seek(SeekFrom::Start(from))?;
    let mut raw = Vec::new();
    file.take(bytes as u64).read_to_end(&mut raw)?;
    let text = String::from_utf8_lossy(&raw).to_string();
    if from == 0 {
        return Ok(text);
    }
    Ok(match text.find('\n') {
        Some(at) => text[at + 1..].to_string(),
        None => text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_is_rotated_rather_than_left_to_grow() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let mut log = LogFile::open(path.clone());
        let line = vec![b'x'; 1024];
        // Past the limit, then one more write to trip the check.
        for _ in 0..(MAX_BYTES / 1024 + 1) {
            log.write_all(&line).unwrap();
        }
        log.write_all(b"after\n").unwrap();

        assert!(
            path.with_extension("log.1").exists(),
            "nothing was kept: the previous log was dropped instead of rotated"
        );
        assert!(
            path.metadata().unwrap().len() < MAX_BYTES,
            "the live file kept growing past the limit"
        );
    }

    #[test]
    fn rotating_twice_replaces_the_previous_log_and_stays_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let mut log = LogFile::open(path.clone());
        log.write_all(b"first generation\n").unwrap();
        log.flush().unwrap();
        {
            let mut held = log.file.lock().unwrap();
            log.rotate(&mut held).unwrap();
        }

        log.write_all(b"second generation\n").unwrap();
        log.flush().unwrap();
        {
            let mut held = log.file.lock().unwrap();
            log.rotate(&mut held).unwrap();
        }

        let previous = path.with_extension("log.1");
        assert_eq!(
            std::fs::read_to_string(previous).unwrap(),
            "second generation\n"
        );
        assert_eq!(path.metadata().unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn diagnostic_logs_are_owner_only_because_agent_output_can_contain_secrets() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("daemon.log");
        let _log = LogFile::open(path.clone());
        assert_eq!(path.metadata().unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn the_tail_is_the_end_of_the_file_and_starts_at_a_line() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("daemon.log"), "first\nsecond\nthird\n").unwrap();
        let text = tail(dir.path(), "daemon.log", 12).unwrap();
        assert!(
            text.ends_with("third\n"),
            "not the end of the file: {text:?}"
        );
        assert!(
            !text.contains("firs"),
            "a half line was served as if it were a line: {text:?}"
        );
    }

    /// A log request names a file in the log directory. Anything that could
    /// leave that directory is refused: this call is reachable by every paired
    /// device, and "read any file" is not what it is for.
    #[test]
    fn a_name_that_climbs_out_of_the_directory_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        for attempt in ["../config.json", "sub/other.log", "", "/etc/passwd"] {
            assert!(
                tail(dir.path(), attempt, 100).is_err(),
                "{attempt} was accepted"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_log_symlink_cannot_read_a_file_outside_the_log_directory() {
        use std::os::unix::fs::symlink;

        let logs = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        std::fs::write(&secret, "host secret").unwrap();
        symlink(&secret, logs.path().join("daemon.log")).unwrap();

        assert!(tail(logs.path(), "daemon.log", 1024).is_err());
    }

    #[test]
    fn the_listing_puts_the_freshest_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("old.log"), "a").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(dir.path().join("new.log"), "bb").unwrap();
        let found = list(dir.path());
        assert_eq!(found[0].0, "new.log");
        assert_eq!(found[0].1, 2);
    }
}
