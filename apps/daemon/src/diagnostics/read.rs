//! Slow read phases, including reads that have not returned yet. Observation
//! never times out, retries or detaches the operation. All times are wall time.

use std::future::Future;
use std::hash::{Hash, Hasher};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use anyhow::Result;
use tracing::Instrument;

const SLOW: Duration = Duration::from_secs(1);
const REPEAT: Duration = Duration::from_secs(30);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

pub(crate) fn key(value: impl Hash) -> u64 {
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hash);
    hash.finish()
}

/// Bound repeated diagnostic failures without hiding the first few examples.
/// Keys are static operation names, never user-controlled identifiers.
pub(crate) fn failure_allowed(operation: &'static str) -> bool {
    type Windows = std::collections::HashMap<&'static str, (Instant, u32)>;
    static WINDOWS: OnceLock<Mutex<Windows>> = OnceLock::new();
    let Ok(mut windows) = WINDOWS.get_or_init(Default::default).lock() else {
        return false;
    };
    let (since, count) = windows.entry(operation).or_insert((Instant::now(), 0));
    if since.elapsed() >= REPEAT {
        *since = Instant::now();
        *count = 0;
    }
    *count = count.saturating_add(1);
    *count <= 4
}

struct Read {
    id: u64,
    operation: &'static str,
    scope_key: Option<u64>,
    home_key: Option<u64>,
    started: Instant,
    outcome: &'static str,
}

impl Read {
    fn report(&self, pending: bool, timer_late: Duration) {
        tracing::warn!(
            event = "session_read_wait",
            read_id = self.id,
            operation = self.operation,
            scope_key = self.scope_key,
            home_key = self.home_key,
            pending,
            outcome = if pending { "pending" } else { self.outcome },
            elapsed_ms = self.started.elapsed().as_millis() as u64,
            timer_late_ms = timer_late.as_millis() as u64,
            "slow session read phase; durations are wall time, not CPU time"
        );
    }
}

impl Drop for Read {
    fn drop(&mut self) {
        if self.started.elapsed() >= SLOW
            || (self.outcome == "error" && failure_allowed(self.operation))
        {
            self.report(false, Duration::ZERO);
        }
    }
}

/// Nested spans associate a caller (including coalesced waiters), its scan and
/// the home/lock phase without logging paths, cursors, errors or session text.
/// Keys are diagnostic fingerprints, never identities or authorization facts.
/// A single-threaded runtime cannot emit while a synchronous Host call is
/// blocked; timer lateness records delayed observation once polling resumes.
pub(crate) async fn observe<T>(
    operation: &'static str,
    scope: Option<&str>,
    home: Option<&Path>,
    future: impl Future<Output = Result<T>>,
) -> Result<T> {
    if !tracing::enabled!(tracing::Level::WARN) {
        return future.await;
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let scope_key = scope.map(key);
    let home_key = home.map(key);
    let span = tracing::warn_span!("session_read", read_id = id, operation, scope_key, home_key);
    async move {
        let mut read = Read {
            id,
            operation,
            scope_key,
            home_key,
            started: Instant::now(),
            outcome: "cancelled",
        };
        tokio::pin!(future);
        let deadline = tokio::time::Instant::now() + SLOW;
        let timer = tokio::time::sleep_until(deadline);
        tokio::pin!(timer);
        let mut deadline = deadline;
        loop {
            tokio::select! {
                result = &mut future => {
                    read.outcome = if result.is_ok() { "ok" } else { "error" };
                    return result;
                }
                _ = &mut timer => {
                    read.report(true, tokio::time::Instant::now().saturating_duration_since(deadline));
                    // No catch-up burst after scheduler/Host stalls.
                    deadline = tokio::time::Instant::now() + REPEAT;
                    timer.as_mut().reset(deadline);
                }
            }
        }
    }
    .instrument(span)
    .await
}
