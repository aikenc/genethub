//! Thin WebSocket RPC client for the local daemon (`genethub-cli.md` §3.1 layer A).
//!
//! Discovery is the same as the desktop shell: read this channel's
//! `endpoint.json`, dial `ws://127.0.0.1:<port>/ws?token=…`, then `Hello`.
//! Business commands refuse to invent a daemon — unreachable is an error the
//! caller must fix with `genet daemon start`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{Reply, Request, ServerFrame, PROTOCOL_VERSION};
use genet_daemon::config::Paths;
use serde_json::json;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::{fail, EXIT_UNREACHABLE};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Reply, String>>>>>;

pub struct Rpc {
    outbound: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next_id: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl Rpc {
    /// Connect to the local daemon for this channel, or exit with
    /// `daemon_unreachable` — the frozen code business commands share.
    pub async fn connect_or_exit() -> Self {
        match Self::connect().await {
            Ok(rpc) => rpc,
            Err(error) => fail(
                "daemon_unreachable",
                &format!(
                    "{error:#}; run `{} daemon start`",
                    genet_daemon::channel::CLI_BINARY
                ),
                EXIT_UNREACHABLE,
            ),
        }
    }

    pub async fn connect() -> Result<Self> {
        let paths = Paths::discover().context("locate the data directory")?;
        let raw = std::fs::read_to_string(paths.endpoint_file()).with_context(|| {
            format!(
                "read {}; is the daemon running?",
                paths.endpoint_file().display()
            )
        })?;
        let endpoint: Endpoint = serde_json::from_str(&raw).context("parse endpoint.json")?;
        let url = format!(
            "ws://127.0.0.1:{}/ws?token={}",
            endpoint.port, endpoint.token
        );

        let (socket, _) = tokio_tungstenite::connect_async(&url)
            .await
            .with_context(|| format!("dial {url}"))?;
        let (mut sink, mut stream) = socket.split();

        let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
        let writer = tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let reader_pending = pending.clone();
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(frame) = serde_json::from_str::<ServerFrame>(&text) else {
                    continue;
                };
                if let ServerFrame::Result {
                    id,
                    ok,
                    payload,
                    error,
                } = frame
                {
                    if let Some(sender) = reader_pending.lock().await.remove(&id) {
                        let outcome = if ok {
                            Ok(payload.unwrap_or(Reply::Ack))
                        } else {
                            Err(error
                                .map(|error| {
                                    format!("{}: {}", error_code_name(error.code), error.message)
                                })
                                .unwrap_or_else(|| "unknown error".into()))
                        };
                        let _ = sender.send(outcome);
                    }
                }
            }
            for (_, sender) in reader_pending.lock().await.drain() {
                let _ = sender.send(Err("the connection closed".into()));
            }
        });

        let rpc = Self {
            outbound,
            pending,
            next_id: AtomicU64::new(1),
            reader,
            writer,
        };
        rpc.call(Request::Hello {
            client_name: format!("{}-cli", genet_daemon::channel::CLI_BINARY),
            protocol_version: PROTOCOL_VERSION,
            device: None,
        })
        .await
        .context("Hello handshake")?;
        Ok(rpc)
    }

    pub async fn call(&self, request: Request) -> Result<Reply> {
        let id = format!("c{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let mut envelope = serde_json::to_value(&request)?;
        envelope
            .as_object_mut()
            .ok_or_else(|| anyhow!("a request must encode as an object"))?
            .insert("id".into(), json!(id));
        self.outbound
            .send(Message::Text(envelope.to_string()))
            .map_err(|_| anyhow!("the connection closed"))?;

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(reply))) => Ok(reply),
            Ok(Ok(Err(message))) => bail!("{message}"),
            Ok(Err(_)) => bail!("the connection closed before answering"),
            Err(_) => bail!("timed out waiting for a reply"),
        }
    }
}

impl Drop for Rpc {
    fn drop(&mut self) {
        self.reader.abort();
        self.writer.abort();
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Endpoint {
    port: u16,
    token: String,
}

fn error_code_name(code: genehub_proto::ErrorCode) -> &'static str {
    use genehub_proto::ErrorCode::*;
    match code {
        BadRequest => "bad_request",
        Unauthorized => "unauthorized",
        NotFound => "not_found",
        Conflict => "conflict",
        Unsupported => "unsupported",
        Forbidden => "forbidden",
        Internal => "internal",
        ProtocolVersion => "protocol_mismatch",
    }
}
