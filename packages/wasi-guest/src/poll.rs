//! Readiness for imports that cannot signal it.
//!
//! A guest import must answer immediately — the blocking variants park the
//! whole instance, so one session waiting on a pipe would freeze every other
//! session in the process. What is left is: probe, and if there was nothing,
//! come back on a timer. This module is that timer, in the shape `poll_read` /
//! `poll_write` need.

use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

/// How long to wait before asking a quiet stream again. Short enough that
/// streamed output still reads as immediate, long enough that an idle pipe is
/// not a busy loop.
pub const IDLE_POLL: Duration = Duration::from_millis(4);

/// A timer that stands in for the readiness notification WASI will not give us.
#[derive(Default)]
pub struct Backoff {
    delay: Option<Pin<Box<tokio::time::Sleep>>>,
}

impl Backoff {
    pub const fn new() -> Self {
        Backoff { delay: None }
    }

    /// True when a previous probe came back empty and its timer has not fired.
    /// The caller should return `Pending` rather than probe again.
    pub fn waiting(&mut self, cx: &mut Context<'_>) -> bool {
        self.delay.is_some() && self.tick(cx).is_pending()
    }

    /// Records that a probe found nothing. Always yields; the task wakes when
    /// the timer fires.
    pub fn idle<T>(&mut self, cx: &mut Context<'_>) -> Poll<T> {
        if self.tick(cx).is_pending() {
            return Poll::Pending;
        }
        // The timer had already expired, so nothing else will wake us.
        cx.waker().wake_by_ref();
        Poll::Pending
    }

    fn tick(&mut self, cx: &mut Context<'_>) -> Poll<()> {
        let sleep = self
            .delay
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(IDLE_POLL)));
        match sleep.as_mut().poll(cx) {
            Poll::Pending => Poll::Pending,
            Poll::Ready(()) => {
                self.delay = None;
                Poll::Ready(())
            }
        }
    }
}

/// The same wait, for `async fn` callers that have no `Context`.
pub async fn idle() {
    tokio::time::sleep(IDLE_POLL).await;
}
