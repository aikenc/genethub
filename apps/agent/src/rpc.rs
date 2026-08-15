//! JSONL transport. Strict LF framing, stdout carries protocol frames only.

use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

enum Frame {
    Json(Value),
    /// Answered once everything queued before it has reached stdout.
    Flush(oneshot::Sender<()>),
}

/// Handle used by every part of the agent to emit frames. Cloning is cheap and
/// all writes funnel through one task, so frames never interleave.
#[derive(Clone)]
pub struct Emitter {
    tx: mpsc::UnboundedSender<Frame>,
}

impl Emitter {
    pub fn send(&self, frame: Value) {
        // A closed channel means stdout is gone; nothing useful left to do.
        let _ = self.tx.send(Frame::Json(frame));
    }

    /// Waits for the write queue to drain. Call before exiting, otherwise
    /// pending frames die with the runtime.
    pub async fn flush(&self) {
        let (tx, rx) = oneshot::channel();
        if self.tx.send(Frame::Flush(tx)).is_ok() {
            let _ = rx.await;
        }
    }

    /// Lets a private in-process run collect frames instead of writing them to
    /// the parent RPC stream. Tests use the same path.
    pub fn collector(sink: mpsc::UnboundedSender<Value>) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
        tokio::spawn(async move {
            while let Some(frame) = rx.recv().await {
                match frame {
                    Frame::Json(value) => {
                        if sink.send(value).is_err() {
                            break;
                        }
                    }
                    Frame::Flush(done) => {
                        let _ = done.send(());
                    }
                }
            }
        });
        Emitter { tx }
    }

    #[cfg(test)]
    pub fn for_test(sink: mpsc::UnboundedSender<Value>) -> Self {
        Self::collector(sink)
    }
}

/// Spawns the writer task and returns its handle.
pub fn start_writer() -> Emitter {
    let (tx, mut rx) = mpsc::unbounded_channel::<Frame>();
    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(frame) = rx.recv().await {
            match frame {
                Frame::Json(value) => {
                    let line = format!("{value}\n");
                    if stdout.write_all(line.as_bytes()).await.is_err() {
                        break;
                    }
                    let _ = stdout.flush().await;
                }
                Frame::Flush(done) => {
                    let _ = stdout.flush().await;
                    let _ = done.send(());
                }
            }
        }
    });
    Emitter { tx }
}

/// Reads stdin as JSONL. Splits on `\n` only and tolerates a trailing `\r`;
/// Unicode line separators stay inside JSON strings where they belong.
pub fn start_reader() -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        let mut lines = BufReader::new(tokio::io::stdin()).split(b'\n');
        while let Ok(Some(chunk)) = lines.next_segment().await {
            let mut text = String::from_utf8_lossy(&chunk).into_owned();
            if text.ends_with('\r') {
                text.pop();
            }
            if text.trim().is_empty() {
                continue;
            }
            if tx.send(text).is_err() {
                break;
            }
        }
    });
    rx
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn frames_reach_the_sink_in_order() {
        let (sink, mut rx) = mpsc::unbounded_channel();
        let emitter = Emitter::for_test(sink);
        emitter.send(json!({"n": 1}));
        emitter.send(json!({"n": 2}));
        emitter.flush().await;

        assert_eq!(rx.recv().await.unwrap()["n"], 1);
        assert_eq!(rx.recv().await.unwrap()["n"], 2);
    }
}
