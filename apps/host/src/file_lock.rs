//! The `file-lock` import: the kernel advisory lock WASI 0.2 has no types for.
//!
//! This is what makes "only one daemon per data directory" true again. The lock
//! is held by this process on the guest's behalf, which is the right owner: a
//! second daemon is a second shell, and the CLI probing from outside sees
//! contention exactly as it would against a native daemon.
//!
//! Delete when Wasmtime ships stable filesystem locks.

use std::fs::{File, OpenOptions};

use fs2::FileExt;
use wasmtime::component::Resource;

use crate::bindings::genehub::host::file_lock as wit;

pub struct LockHandle {
    file: File,
}

/// Contention is an answer, not a failure. Anything else is a real error.
fn acquired(result: std::io::Result<()>) -> Result<bool, String> {
    match result {
        Ok(()) => Ok(true),
        Err(error)
            if error.kind() == std::io::ErrorKind::WouldBlock
                || (error.raw_os_error().is_some()
                    && error.raw_os_error() == fs2::lock_contended_error().raw_os_error()) =>
        {
            Ok(false)
        }
        Err(error) => Err(error.to_string()),
    }
}

impl wit::HostHandle for crate::load::Host {
    async fn try_lock_shared(&mut self, this: Resource<LockHandle>) -> Result<bool, String> {
        let handle = self.table.get(&this).map_err(|error| error.to_string())?;
        acquired(FileExt::try_lock_shared(&handle.file))
    }

    async fn try_lock_exclusive(&mut self, this: Resource<LockHandle>) -> Result<bool, String> {
        let handle = self.table.get(&this).map_err(|error| error.to_string())?;
        acquired(FileExt::try_lock_exclusive(&handle.file))
    }

    async fn unlock(&mut self, this: Resource<LockHandle>) -> Result<(), String> {
        let handle = self.table.get(&this).map_err(|error| error.to_string())?;
        FileExt::unlock(&handle.file).map_err(|error| error.to_string())
    }

    async fn drop(&mut self, this: Resource<LockHandle>) -> wasmtime::Result<()> {
        // Closing the descriptor is what releases the lock, so letting the
        // resource go is a complete unlock even after a guest panic.
        let _ = self.table.delete(this);
        Ok(())
    }
}

impl wit::Host for crate::load::Host {
    async fn open(&mut self, path: String) -> Result<Resource<LockHandle>, String> {
        let host_path = crate::guest_paths::host_path_from_guest(&path);
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&host_path)
            .map_err(|error| format!("opening {path}: {error}"))?;
        self.table
            .push(LockHandle { file })
            .map_err(|error| error.to_string())
    }
}
