//! Where slow work goes.
//!
//! Two tools, because there are two kinds of slow. Bounded work is offloaded
//! ([`run`]): native has a blocking pool, and wasip2 has none, so there it runs
//! inline — `tokio::task::spawn_blocking` panics on that target. Work whose
//! size the user chooses is written as steps instead, with [`breathe`] between
//! them, because a guest has nowhere to put it.

use anyhow::{Context, Result};

/// Gives the scheduler its turn between the steps of a long job.
///
/// The guest has no pool to move work to and no second thread to run it on:
/// Wasmtime runs the whole component on one fiber, so a loop that never awaits
/// holds every session the daemon is serving until it ends. Work whose size the
/// user chooses — reading a file, walking a project — therefore has to be
/// written as steps with this between them, and [`run`] is left for the small,
/// bounded work it can still swallow whole.
///
/// Native yields too rather than keeping a second shape of the same code. It
/// costs a scheduler hop and buys the same fairness there.
pub async fn breathe() {
    tokio::task::yield_now().await;
}

/// Short, bounded work: a stat, a small write, a directory listing.
pub async fn run<F, T>(work: F) -> Result<T>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    #[cfg(not(target_family = "wasm"))]
    {
        tokio::task::spawn_blocking(work)
            .await
            .context("joining blocking work")
    }
    #[cfg(target_family = "wasm")]
    {
        Ok(work())
    }
}
