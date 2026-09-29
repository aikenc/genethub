//! The one piece of boilerplate every stdio-speaking adapter shares: writing
//! a newline-delimited JSON frame.
//!
//! Request correlation is shared; each adapter still translates its own
//! notifications and inbound user interactions.

use crate::os_process::ChildStdin;
use anyhow::{Context, Result};
use serde_json::Value;
use tokio::io::AsyncWriteExt;

use serde_json::json;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex as ReplyMutex,
};
use tokio::sync::{oneshot, Mutex};
use tokio::time::Instant;

#[derive(Clone, Copy)]
pub(super) enum RpcCodec {
    JsonRpc,
    ClaudeControl,
}

type Reply = std::result::Result<Value, String>;

pub(super) struct StdioRpcPeer {
    codec: RpcCodec,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: ReplyMutex<HashMap<String, (u64, oneshot::Sender<Reply>)>>,
    closed: AtomicBool,
    next_registration: AtomicU64,
}

impl StdioRpcPeer {
    pub fn new(codec: RpcCodec, stdin: Arc<Mutex<ChildStdin>>) -> Arc<Self> {
        Arc::new(Self {
            codec,
            stdin,
            pending: ReplyMutex::new(HashMap::new()),
            closed: AtomicBool::new(false),
            next_registration: AtomicU64::new(0),
        })
    }

    pub async fn call(
        self: &Arc<Self>,
        id: Value,
        method: &str,
        params: Value,
        deadline: Option<Instant>,
    ) -> Reply {
        // The deadline includes the write as well as the response.
        let exchange = async {
            self.start(id, method, params)
                .await?
                .receive()
                .await
                .map_err(|_| "the agent closed the connection".to_string())?
        };
        match deadline {
            Some(deadline) => tokio::time::timeout_at(deadline, exchange)
                .await
                .unwrap_or_else(|_| Err(format!("the agent did not answer {method}"))),
            None => exchange.await,
        }
    }

    /// Register and write before acknowledging delivery of a long-lived request.
    pub async fn start(
        self: &Arc<Self>,
        id: Value,
        method: &str,
        params: Value,
    ) -> std::result::Result<PendingReply, String> {
        let key = id.to_string();
        let (tell, told) = oneshot::channel();
        let generation = self.next_registration.fetch_add(1, Ordering::Relaxed);
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            if self.closed.load(Ordering::Relaxed) {
                return Err("the agent closed the connection".into());
            }
            if pending.contains_key(&key) {
                return Err("duplicate request id".into());
            }
            pending.insert(key.clone(), (generation, tell));
        }
        let reply = PendingReply {
            told,
            _registration: RequestRegistration {
                peer: self.clone(),
                key,
                generation,
            },
        };
        let frame = match self.codec {
            RpcCodec::JsonRpc => {
                json!({"jsonrpc":"2.0", "id":id, "method":method, "params":params})
            }
            RpcCodec::ClaudeControl => {
                let mut request = params;
                request["subtype"] = Value::String(method.to_string());
                json!({"type":"control_request", "request_id":id, "request":request})
            }
        };
        write_json_line(&mut *self.stdin.lock().await, &frame)
            .await
            .map_err(|e| e.to_string())?;
        Ok(reply)
    }

    pub fn response(&self, frame: &Value) -> bool {
        let (id, result) = match self.codec {
            RpcCodec::JsonRpc if frame.get("method").is_none() => {
                let Some(id) = frame.get("id") else {
                    return false;
                };
                let result = match frame.get("error") {
                    Some(error) => Err(error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown error")
                        .to_string()),
                    None => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                };
                (id, result)
            }
            RpcCodec::ClaudeControl
                if frame.get("type").and_then(Value::as_str) == Some("control_response") =>
            {
                let response = &frame["response"];
                let Some(id) = response.get("request_id") else {
                    return false;
                };
                let result = if response["subtype"] == "success" {
                    Ok(response.get("response").cloned().unwrap_or(Value::Null))
                } else {
                    Err(response
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("no reason given")
                        .to_string())
                };
                (id, result)
            }
            _ => return false,
        };
        if let Some((_, tell)) = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .remove(&id.to_string())
        {
            let _ = tell.send(result);
        }
        true
    }

    pub fn fail_open(&self) {
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        self.closed.store(true, Ordering::Relaxed);
        pending.clear();
    }
}

pub(super) struct PendingReply {
    told: oneshot::Receiver<Reply>,
    _registration: RequestRegistration,
}

impl PendingReply {
    pub async fn receive(self) -> std::result::Result<Reply, oneshot::error::RecvError> {
        self.told.await
    }
}

struct RequestRegistration {
    peer: Arc<StdioRpcPeer>,
    key: String,
    generation: u64,
}

impl Drop for RequestRegistration {
    fn drop(&mut self) {
        // Cancellation, write failure, timeout and a successful reply all
        // remove exactly the registration they own, without an async cleanup.
        let mut pending = self.peer.pending.lock().unwrap_or_else(|p| p.into_inner());
        if pending
            .get(&self.key)
            .is_some_and(|(generation, _)| *generation == self.generation)
        {
            pending.remove(&self.key);
        }
    }
}

/// Serializes `value` and writes it as one line to `stdin`, flushing after.
pub async fn write_json_line(stdin: &mut ChildStdin, value: &Value) -> Result<()> {
    let mut line = serde_json::to_string(value)?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .context("writing to the agent process")?;
    stdin.flush().await?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::os_process::Command;
    use std::process::Stdio;
    use std::time::Duration;

    async fn peer(codec: RpcCodec) -> (Arc<StdioRpcPeer>, crate::os_process::Child) {
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        (StdioRpcPeer::new(codec, Arc::new(Mutex::new(stdin))), child)
    }

    #[tokio::test]
    async fn replies_preserve_id_types_and_fail_every_open_request_on_eof() {
        let (peer, _child) = peer(RpcCodec::JsonRpc).await;
        let numeric = peer.start(json!(7), "initialize", json!({})).await.unwrap();
        let string = peer
            .start(json!("7"), "initialize", json!({}))
            .await
            .unwrap();
        assert!(peer.response(&json!({"id":"7","result":{"ok":true}})));
        assert_eq!(string.receive().await.unwrap().unwrap(), json!({"ok":true}));
        assert_eq!(peer.pending.lock().unwrap().len(), 1);
        peer.fail_open();
        assert!(numeric.receive().await.is_err());
        assert!(peer.pending.lock().unwrap().is_empty());
        assert!(peer.start(json!(8), "initialize", json!({})).await.is_err());
    }

    #[tokio::test]
    async fn a_completed_requests_guard_does_not_cancel_a_reused_id() {
        let (peer, _child) = peer(RpcCodec::JsonRpc).await;
        let previous = peer.start(json!(1), "initialize", json!({})).await.unwrap();
        assert!(peer.response(&json!({"id":1,"result":{}})));
        let next = peer.start(json!(1), "initialize", json!({})).await.unwrap();
        drop(previous);
        assert_eq!(peer.pending.lock().unwrap().len(), 1);
        assert!(peer.response(&json!({"id":1,"result":"next"})));
        assert_eq!(next.receive().await.unwrap().unwrap(), json!("next"));
    }

    #[tokio::test]
    async fn cancellation_and_deadline_remove_their_registration() {
        let (peer, _child) = peer(RpcCodec::JsonRpc).await;
        let request = peer.start(json!(1), "initialize", json!({})).await.unwrap();
        assert!(peer.start(json!(1), "initialize", json!({})).await.is_err());
        drop(request);
        assert!(peer.pending.lock().unwrap().is_empty());
        assert!(peer
            .call(
                json!(2),
                "initialize",
                json!({}),
                Some(Instant::now() + Duration::from_millis(20))
            )
            .await
            .is_err());
        assert!(peer.pending.lock().unwrap().is_empty());
        assert!(peer.response(&json!({"id":2,"result":{}})));
        assert!(peer.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn claude_success_and_error_share_the_same_cleanup() {
        let (peer, _child) = peer(RpcCodec::ClaudeControl).await;
        let success = peer
            .start(json!("yes"), "set_model", json!({"model":"x"}))
            .await
            .unwrap();
        let error = peer
            .start(json!("no"), "set_model", json!({"model":"y"}))
            .await
            .unwrap();
        assert!(peer.response(&json!({"type":"control_response", "response":{"request_id":"yes","subtype":"success","response":{}}})));
        assert!(success.receive().await.unwrap().is_ok());
        assert!(peer.response(&json!({"type":"control_response", "response":{"request_id":"no","subtype":"error","error":"rejected"}})));
        assert_eq!(error.receive().await.unwrap().unwrap_err(), "rejected");
        assert!(peer.pending.lock().unwrap().is_empty());
    }
}
