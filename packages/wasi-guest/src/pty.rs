//! Terminals, over the shell's import.
//!
//! Same shape as [`crate::process`] and for the same reason: a WIT resource is
//! neither `Send` nor `Sync`, and the daemon keeps its terminals in a map it
//! shares across tasks. So the resource stays in a thread-local registry and
//! what travels is a number.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io;

use crate::wit::genehub::host::pty as host;

thread_local! {
    static SESSIONS: RefCell<HashMap<u64, host::Session>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(1) };
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the terminal is gone")
}

fn with<R>(id: u64, f: impl FnOnce(&host::Session) -> R) -> io::Result<R> {
    SESSIONS.with_borrow(|map| map.get(&id).map(f).ok_or_else(gone))
}

/// An open terminal. Dropping it hangs the session up.
pub struct Session(u64);

impl Session {
    pub fn open(
        argv: &[String],
        cwd: &str,
        env: &[(String, String)],
        cols: u16,
        rows: u16,
    ) -> io::Result<Session> {
        let session = host::open(argv, cwd, env, cols, rows).map_err(io::Error::other)?;
        let id = NEXT.with(|next| {
            let value = next.get();
            next.set(value + 1);
            value
        });
        SESSIONS.with_borrow_mut(|map| map.insert(id, session));
        Ok(Session(id))
    }

    /// `Ok(None)` once the terminal is over; `Ok(Some(empty))` means nothing
    /// has arrived yet.
    pub fn read(&self, max: u32) -> io::Result<Option<Vec<u8>>> {
        with(self.0, |session| session.read(max))?.map_err(io::Error::other)
    }

    pub fn write(&self, data: &[u8]) -> io::Result<usize> {
        with(self.0, |session| session.write(data))?
            .map(|written| written as usize)
            .map_err(io::Error::other)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        with(self.0, |session| session.resize(cols, rows))?.map_err(io::Error::other)
    }

    pub fn exit_code(&self) -> Option<i32> {
        with(self.0, host::Session::exit_code).ok().flatten()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        SESSIONS.with_borrow_mut(|map| map.remove(&self.0));
    }
}
