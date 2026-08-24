//! Advisory file locks.
//!
//! Native takes the kernel lock itself (`fs2`). WASI 0.2 has no lock types, so
//! the guest asks the shell to hold one for it — which is the same guarantee,
//! because a second daemon is a second shell process and contends for real.
//!
//! The path is passed alongside the file because the host interface is
//! path-addressed: the guest cannot hand a descriptor across the boundary.

use std::fs::File;
use std::io;
use std::path::Path;

#[cfg(not(target_family = "wasm"))]
pub fn try_lock_exclusive(file: &File, _path: &Path) -> io::Result<()> {
    fs2::FileExt::try_lock_exclusive(file)
}

#[cfg(not(target_family = "wasm"))]
pub fn try_lock_shared(file: &File, _path: &Path) -> io::Result<()> {
    fs2::FileExt::try_lock_shared(file)
}

#[cfg(not(target_family = "wasm"))]
pub fn unlock(file: &File, _path: &Path) -> io::Result<()> {
    fs2::FileExt::unlock(file)
}

#[cfg(not(target_family = "wasm"))]
pub fn lock_contended_error() -> io::Error {
    fs2::lock_contended_error()
}

#[cfg(target_family = "wasm")]
mod wasm {
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::fs::File;
    use std::io;
    use std::path::Path;

    use genet_wasi::wit::genehub::host::file_lock as host;

    thread_local! {
        /// Live locks, by the path they were taken on. Holding the handle is
        /// what holds the lock; dropping it is what releases it.
        static HELD: RefCell<HashMap<String, host::Handle>> = RefCell::new(HashMap::new());
    }

    pub fn lock_contended_error() -> io::Error {
        io::Error::from(io::ErrorKind::WouldBlock)
    }

    fn take(path: &Path, exclusive: bool) -> io::Result<()> {
        let key = path.to_string_lossy().into_owned();
        // Re-locking what we already hold is what the native flock does too.
        if HELD.with_borrow(|held| held.contains_key(&key)) {
            return Ok(());
        }
        let handle = host::open(&key).map_err(io::Error::other)?;
        let acquired = if exclusive {
            handle.try_lock_exclusive()
        } else {
            handle.try_lock_shared()
        }
        .map_err(io::Error::other)?;
        if !acquired {
            return Err(lock_contended_error());
        }
        HELD.with_borrow_mut(|held| held.insert(key, handle));
        Ok(())
    }

    pub fn try_lock_exclusive(_file: &File, path: &Path) -> io::Result<()> {
        take(path, true)
    }

    pub fn try_lock_shared(_file: &File, path: &Path) -> io::Result<()> {
        take(path, false)
    }

    pub fn unlock(_file: &File, path: &Path) -> io::Result<()> {
        let key = path.to_string_lossy().into_owned();
        HELD.with_borrow_mut(|held| held.remove(&key));
        Ok(())
    }
}

#[cfg(target_family = "wasm")]
pub use wasm::{lock_contended_error, try_lock_exclusive, try_lock_shared, unlock};
