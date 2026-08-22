//! One direct WebRTC data channel, over the shell's import.
//!
//! Same shape as [`crate::pty`] and for the same two reasons: a WIT resource is
//! neither `Send` nor `Sync` while the daemon hands its connections to spawned
//! tasks, and no import may block. So the resource stays in a thread-local
//! registry, what travels is a number, and every wait is a probe plus the
//! shared timer.
//!
//! This is the connection and nothing else. Who may connect, what a message
//! means, and how long a stranger may hold a slot are the daemon's
//! (`apps/daemon/src/dataplane/rtc.rs`).

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io;
use std::time::Duration;

use crate::poll::idle;
use crate::wit::genehub::host::rtc as host;

thread_local! {
    static SESSIONS: RefCell<HashMap<u64, host::Session>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(1) };
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the RTC session is gone")
}

fn with<R>(id: u64, f: impl FnOnce(&host::Session) -> R) -> io::Result<R> {
    SESSIONS.with_borrow(|map| map.get(&id).map(f).ok_or_else(gone))
}

/// What the connection is doing, as far as anything above it is concerned.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum State {
    Connecting,
    Open,
    Closed,
}

/// How the shell should answer: where to gather from, and what it may accept.
pub struct Config {
    pub ice_servers: Vec<String>,
    pub channel_label: String,
    pub gather_timeout: Duration,
    pub max_message_bytes: usize,
    pub queue_depth: usize,
}

/// An answered offer. Dropping it closes the connection.
pub struct Session(u64);

impl Session {
    /// Starts answering `offer`. Returns before there is an answer: ICE
    /// gathering is a network wait, and [`Session::answer`] is where it is
    /// waited for.
    pub fn accept(offer: &str, config: &Config) -> io::Result<Session> {
        let session = host::accept(
            offer,
            &host::Config {
                ice_servers: config.ice_servers.clone(),
                channel_label: config.channel_label.clone(),
                gather_timeout_ms: config.gather_timeout.as_millis().min(u32::MAX as u128) as u32,
                max_message_bytes: config.max_message_bytes.min(u32::MAX as usize) as u32,
                queue_depth: config.queue_depth.min(u32::MAX as usize) as u32,
            },
        )
        .map_err(io::Error::other)?;
        let id = NEXT.with(|next| {
            let value = next.get();
            next.set(value + 1);
            value
        });
        SESSIONS.with_borrow_mut(|map| map.insert(id, session));
        Ok(Session(id))
    }

    /// The SDP answer, waited for. `patience` bounds the whole wait, including
    /// the shell's own gathering timeout, so a peer never holds this open on a
    /// machine whose candidates never arrive.
    pub async fn answer(&self, patience: Duration) -> io::Result<String> {
        let deadline = tokio::time::Instant::now() + patience;
        loop {
            if let Some(answer) = with(self.0, host::Session::answer)? {
                return Ok(answer);
            }
            if self.state() == State::Closed {
                return Err(io::Error::other("the connection ended before it answered"));
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "no RTC answer was gathered in time",
                ));
            }
            idle().await;
        }
    }

    pub fn state(&self) -> State {
        match with(self.0, host::Session::current) {
            Ok(host::State::Connecting) => State::Connecting,
            Ok(host::State::Open) => State::Open,
            _ => State::Closed,
        }
    }

    /// The oldest message the peer sent, or `None` when none is waiting. The
    /// end of the connection is [`Session::state`], not an empty answer.
    pub fn receive(&self) -> Option<Vec<u8>> {
        with(self.0, host::Session::receive).ok().flatten()
    }

    /// The next message the peer sends, waited for. `None` once the connection
    /// has ended with nothing left to take.
    pub async fn next(&self) -> Option<Vec<u8>> {
        loop {
            if let Some(message) = self.receive() {
                return Some(message);
            }
            if self.state() == State::Closed {
                return None;
            }
            idle().await;
        }
    }

    /// Queues one binary message. Fails rather than dropping it: this carries
    /// framed records, and a peer that silently lost one can no longer read the
    /// rest of the stream.
    pub fn send(&self, data: &[u8]) -> io::Result<()> {
        with(self.0, |session| session.send(data))?.map_err(io::Error::other)
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        SESSIONS.with_borrow_mut(|map| map.remove(&self.0));
    }
}
