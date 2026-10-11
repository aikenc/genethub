//! JSON-RPC 2.0 to one `serve` process, one object per `\n`.
//!
//! The daemon sends requests and waits with a deadline; the script replies
//! and sends notifications. Anything else on the pipe is ignored. When the
//! process goes away every waiting call fails at once and the owner is told.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::adapter::stdio::write_json_line;
use crate::os_process::{Child, ChildStdin};

/// What the script said, kept for `genet agent logs` and for explaining a
/// failure. Bounded so a chatty script cannot grow the daemon.
#[derive(Default)]
pub struct LogRing {
    lines: std::sync::Mutex<VecDeque<String>>,
}

impl LogRing {
    const LINES: usize = 500;

    pub fn push(&self, line: String) {
        let mut lines = self.lines.lock().expect("log ring is never poisoned");
        if lines.len() == Self::LINES {
            lines.pop_front();
        }
        lines.push_back(line);
    }

    pub fn tail(&self, count: usize) -> Vec<String> {
        let lines = self.lines.lock().expect("log ring is never poisoned");
        let skip = lines.len().saturating_sub(count);
        lines.iter().skip(skip).cloned().collect()
    }
}

pub enum Inbound {
    Notification { method: String, params: Value },
    Exited,
}

#[derive(Debug)]
pub enum CallError {
    /// No answer before the deadline.
    Timeout,
    /// The process is gone, or the pipe broke.
    Gone(String),
    /// The script answered with an error; the message is for the user.
    Remote(String),
}

impl std::fmt::Display for CallError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CallError::Timeout => f.write_str("没有在限定时间内回应"),
            CallError::Gone(why) => write!(f, "Agent 脚本不在运行：{why}"),
            CallError::Remote(message) => f.write_str(message),
        }
    }
}

type Pending = std::sync::Mutex<HashMap<u64, oneshot::Sender<Result<Value, CallError>>>>;

pub struct Peer {
    stdin: Mutex<ChildStdin>,
    pending: Arc<Pending>,
    next_id: AtomicU64,
    child: Arc<Mutex<Option<Child>>>,
    pid: Option<u32>,
    readers: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Peer {
    /// Takes a spawned child with piped stdio and starts reading it.
    pub fn attach(
        mut child: Child,
        target: String,
        logs: Arc<LogRing>,
        inbound: mpsc::UnboundedSender<Inbound>,
    ) -> Arc<Peer> {
        let stdout = child.stdout.take().expect("stdout was piped");
        let stderr = child.stderr.take().expect("stderr was piped");
        let stdin = child.stdin.take().expect("stdin was piped");
        let pid = child.id();
        let pending: Arc<Pending> = Arc::default();
        let peer = Arc::new(Peer {
            stdin: Mutex::new(stdin),
            pending: pending.clone(),
            next_id: AtomicU64::new(1),
            child: Arc::new(Mutex::new(Some(child))),
            pid,
            readers: std::sync::Mutex::new(Vec::new()),
        });

        let stderr_logs = logs.clone();
        let stderr_target = target.clone();
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            while let Some(line) = next_line(&mut reader).await {
                tracing::info!(target: "agent", "{stderr_target}: {line}");
                stderr_logs.push(line);
            }
        });

        let stdout_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            while let Some(line) = next_line(&mut reader).await {
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    logs.push(format!("[daemon] 无法解析的协议行：{}", truncate(&line)));
                    continue;
                };
                route(&message, &pending, &inbound);
            }
            let waiting: Vec<_> = pending
                .lock()
                .expect("pending map is never poisoned")
                .drain()
                .collect();
            for (_, sender) in waiting {
                let _ = sender.send(Err(CallError::Gone("进程已退出".into())));
            }
            let _ = inbound.send(Inbound::Exited);
            tracing::info!(target: "agent", "{target}: serve exited");
        });
        *peer.readers.lock().expect("never poisoned") = vec![stdout_task, stderr_task];
        peer
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        deadline: Duration,
    ) -> Result<Value, CallError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending
            .lock()
            .expect("pending map is never poisoned")
            .insert(id, sender);
        let frame = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        // Waiting for the pipe is part of the deadline: a script that stopped
        // reading leaves an earlier write holding it.
        let until = tokio::time::Instant::now() + deadline;
        let written = tokio::time::timeout_at(until, async {
            let mut stdin = self.stdin.lock().await;
            write_json_line(&mut stdin, &frame).await
        })
        .await;
        match written {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                self.forget(id);
                return Err(CallError::Gone(error.to_string()));
            }
            Err(_) => {
                self.forget(id);
                return Err(CallError::Timeout);
            }
        }
        match tokio::time::timeout_at(until, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(CallError::Gone("进程已退出".into())),
            Err(_) => {
                self.forget(id);
                Err(CallError::Timeout)
            }
        }
    }

    fn forget(&self, id: u64) {
        self.pending
            .lock()
            .expect("pending map is never poisoned")
            .remove(&id);
    }

    /// How the process ended, once it has; `None` while it still runs.
    pub async fn ending(&self) -> Option<crate::adapter::Ending> {
        crate::adapter::ending(&self.child).await
    }

    /// Ends the process and everything it started. The readers are given a
    /// moment to see end-of-file, so the owner still hears about the exit.
    pub async fn kill(&self) {
        if let Err(error) = crate::adapter::close_child(&self.child).await {
            tracing::warn!(%error, "could not confirm the Agent script exited");
        }
        let readers = std::mem::take(&mut *self.readers.lock().expect("never poisoned"));
        for mut reader in readers {
            if tokio::time::timeout(Duration::from_secs(1), &mut reader)
                .await
                .is_err()
            {
                reader.abort();
            }
        }
    }
}

fn route(message: &Value, pending: &Pending, inbound: &mpsc::UnboundedSender<Inbound>) {
    let id = message.get("id").and_then(Value::as_u64);
    let method = message.get("method").and_then(Value::as_str);
    match (id, method) {
        (Some(id), None) => {
            let Some(sender) = pending
                .lock()
                .expect("pending map is never poisoned")
                .remove(&id)
            else {
                return;
            };
            let result = match message.get("error") {
                Some(error) => Err(CallError::Remote(
                    error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Agent 脚本返回了错误")
                        .to_string(),
                )),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = sender.send(result);
        }
        (None, Some(method)) => {
            let _ = inbound.send(Inbound::Notification {
                method: method.to_string(),
                params: message.get("params").cloned().unwrap_or(Value::Null),
            });
        }
        // A request from the script: the protocol has none in this direction.
        _ => {}
    }
}

/// One `\n`-terminated line, decoded leniently: a script or its child that
/// writes invalid UTF-8 must not stop the reader (a stopped stderr reader
/// fills the pipe and wedges the script). `None` at end of file or on a read
/// error.
async fn next_line<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Option<String> {
    let mut buffer = Vec::new();
    match reader.read_until(b'\n', &mut buffer).await {
        Ok(0) | Err(_) => None,
        Ok(_) => {
            while matches!(buffer.last(), Some(b'\n' | b'\r')) {
                buffer.pop();
            }
            Some(String::from_utf8_lossy(&buffer).into_owned())
        }
    }
}

fn truncate(line: &str) -> String {
    line.chars().take(200).collect()
}
