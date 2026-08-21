//! Facts about the running process that WASI does not report.
//!
//! The guest has no pid of its own and no temp directory: `std::process::id`
//! and `std::env::temp_dir` both abort on `wasm32-wasip2` rather than return
//! anything. See the v2 proposal §6.9.

use std::path::PathBuf;

#[cfg(not(target_family = "wasm"))]
pub fn pid() -> u32 {
    std::process::id()
}

/// The shell's pid, which is the process anyone outside can actually see.
#[cfg(target_family = "wasm")]
pub fn pid() -> u32 {
    std::env::var("GENEHUB_DEV_HOST_PID")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

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
    std::env::var("GENEHUB_DEV_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
}
