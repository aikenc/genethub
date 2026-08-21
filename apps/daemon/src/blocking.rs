//! Offload work that is blocking on native and inline on WASI.
//!
//! `tokio::task::spawn_blocking` panics on wasip2 (no blocking pool). The
//! native path keeps the pool.

use anyhow::{Context, Result};

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
