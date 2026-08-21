//! Standard input and output as `AsyncRead` / `AsyncWrite`.
//!
//! `tokio::io::stdin` is not available here: it hands the descriptor to a
//! blocking thread, and this target has no threads. WASI does give stdio as
//! ordinary streams, and those read and write without blocking, so the same
//! probe-and-back-off used for child pipes applies.
//!
//! Not `std::io::stdout` either — its write blocks until the host drains, and
//! a full pipe would freeze the instance rather than one task.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use wasi::io::streams::{InputStream, OutputStream, StreamError};

use crate::poll::Backoff;

const CHUNK: u64 = 64 * 1024;

pub struct Stdin {
    stream: InputStream,
    delay: Backoff,
}

pub struct Stdout {
    stream: OutputStream,
    delay: Backoff,
}

/// Both are single-owner: WASI hands out one stream per descriptor, and taking
/// it twice would split the byte order between two readers.
pub fn stdin() -> Stdin {
    Stdin {
        stream: wasi::cli::stdin::get_stdin(),
        delay: Backoff::new(),
    }
}

pub fn stdout() -> Stdout {
    Stdout {
        stream: wasi::cli::stdout::get_stdout(),
        delay: Backoff::new(),
    }
}

pub fn stderr() -> Stdout {
    Stdout {
        stream: wasi::cli::stderr::get_stderr(),
        delay: Backoff::new(),
    }
}

fn failed(context: &str, error: StreamError) -> io::Error {
    match error {
        StreamError::Closed => io::Error::new(io::ErrorKind::BrokenPipe, format!("{context}: closed")),
        StreamError::LastOperationFailed(e) => {
            io::Error::other(format!("{context}: {}", e.to_debug_string()))
        }
    }
}

impl AsyncRead for Stdin {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        if me.delay.waiting(cx) {
            return Poll::Pending;
        }
        let want = (buf.remaining() as u64).min(CHUNK);
        if want == 0 {
            return Poll::Ready(Ok(()));
        }
        match me.stream.read(want) {
            // An untouched buffer is how `AsyncRead` spells EOF.
            Err(StreamError::Closed) => Poll::Ready(Ok(())),
            Err(e) => Poll::Ready(Err(failed("reading stdin", e))),
            Ok(chunk) if chunk.is_empty() => me.delay.idle(cx),
            Ok(chunk) => {
                buf.put_slice(&chunk);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncWrite for Stdout {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        if me.delay.waiting(cx) {
            return Poll::Pending;
        }
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        let permitted = match me.stream.check_write() {
            Ok(0) => return me.delay.idle(cx),
            Ok(n) => usize::try_from(n).unwrap_or(usize::MAX),
            Err(e) => return Poll::Ready(Err(failed("writing stdout", e))),
        };
        let end = buf.len().min(permitted);
        match me.stream.write(&buf[..end]) {
            Ok(()) => Poll::Ready(Ok(end)),
            Err(e) => Poll::Ready(Err(failed("writing stdout", e))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        match me.stream.flush() {
            Ok(()) => Poll::Ready(Ok(())),
            // Nothing left to flush into is not a flush failure.
            Err(StreamError::Closed) => Poll::Ready(Ok(())),
            Err(e) => Poll::Ready(Err(failed("flushing stdout", e))),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.poll_flush(cx)
    }
}
