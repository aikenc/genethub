//! Where slow work goes.
//!
//! Two tools, because there are two kinds of slow. Bounded work is offloaded
//! ([`run`]): native has a blocking pool, and wasip2 has none, so there it runs
//! inline — `tokio::task::spawn_blocking` panics on that target. Work whose
//! size the user chooses is written as steps instead, with [`breathe`] between
//! them, because a guest has nowhere to put it.

use anyhow::{Context, Result};

/// Only overlapping reads share a result. Weak entries retain neither a
/// snapshot nor a running task after the last caller leaves. OnceCell lets a
/// surviving caller retry if the initializer fails or is cancelled.
pub(crate) type InFlightReads<K, V> =
    std::sync::Mutex<std::collections::HashMap<K, std::sync::Weak<tokio::sync::OnceCell<V>>>>;

pub(crate) async fn coalesce<K, V, F, Fut>(
    reads: &InFlightReads<K, V>,
    key: K,
    read: F,
) -> Result<V>
where
    K: Eq + std::hash::Hash,
    V: Clone,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<V>>,
{
    let cell = {
        let mut reads = reads
            .lock()
            .map_err(|_| anyhow::anyhow!("in-flight reads lock was poisoned"))?;
        reads.retain(|_, value| value.strong_count() > 0);
        match reads.get(&key).and_then(std::sync::Weak::upgrade) {
            Some(cell) => cell,
            None => {
                let cell = std::sync::Arc::new(tokio::sync::OnceCell::new());
                reads.insert(key, std::sync::Arc::downgrade(&cell));
                cell
            }
        }
    };
    cell.get_or_try_init(read).await.cloned()
}

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
