//! Filesystem facts that WASI does not report like a native process.
//!
//! The guest has no temp directory, and `std::env::temp_dir` aborts on
//! `wasm32-wasip2` rather than returning one. See the v2 proposal §6.9.

use std::path::PathBuf;

#[cfg(not(target_family = "wasm"))]
pub fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

#[cfg(target_family = "wasm")]
pub fn temp_dir() -> PathBuf {
    std::env::var("TMPDIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

#[cfg(not(target_family = "wasm"))]
pub fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// The shell's working directory. A component has none of its own: WASI
/// reaches the filesystem through preopens, and `current_dir` answers with the
/// preopen root no matter where the process was started.
#[cfg(target_family = "wasm")]
pub fn cwd() -> PathBuf {
    std::env::var(crate::channel::ENV_CWD)
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}

/// Opens a file to append one line to it.
///
/// wasip2 silently drops O_APPEND: an append handle there writes at offset 0
/// every time, which turns the session log into its own last line. The guest
/// opens read+write and positions at the end itself; the session file has
/// this one process as its writer. Native keeps O_APPEND.
#[cfg(not(target_family = "wasm"))]
pub fn open_append(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
}

#[cfg(target_family = "wasm")]
pub fn open_append(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    use std::io::Seek;
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(path)?;
    file.seek(std::io::SeekFrom::End(0))?;
    Ok(file)
}
