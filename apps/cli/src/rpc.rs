//! Thin WebSocket RPC client for the local daemon (`genethub-cli.md` §3.1 layer A).
//!
//! Discovery is the same as the desktop shell: read this channel's
//! `endpoint.json`, mint a one-use loopback admission, then `Hello`.
//! Business commands refuse to invent a daemon — unreachable is an error the
//! caller must fix with `genet daemon start`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use genehub_proto::{HelloResult, ProtocolError, Reply, Request, ServerFrame, PROTOCOL_VERSION};
use genet_daemon::config::Paths;
use serde_json::json;
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::{fail, EXIT_UNREACHABLE};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Reply, RpcError>>>>>;

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    Remote(ProtocolError),
    Transport(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Remote(error) => {
                write!(
                    formatter,
                    "{}: {}",
                    error_code_name(error.code),
                    error.message
                )
            }
            RpcError::Transport(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RpcError {}

#[derive(Debug, Clone, PartialEq)]
pub enum ConnectError {
    Unavailable(String),
    Rejected(ProtocolError),
    Protocol(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Unavailable(message) | ConnectError::Protocol(message) => {
                formatter.write_str(message)
            }
            ConnectError::Rejected(error) => write!(
                formatter,
                "{}: {}",
                error_code_name(error.code),
                error.message
            ),
        }
    }
}

impl std::error::Error for ConnectError {}

pub struct Rpc {
    outbound: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next_id: AtomicU64,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
    hello: Option<HelloResult>,
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
                    "{error}; run `{} daemon start`",
                    genet_daemon::channel::CLI_BINARY
                ),
                EXIT_UNREACHABLE,
            ),
        }
    }

    pub async fn connect() -> Result<Self, ConnectError> {
        let paths = Paths::discover().map_err(|error| {
            ConnectError::Unavailable(format!("locate the data directory: {error:#}"))
        })?;
        let raw = std::fs::read_to_string(paths.endpoint_file()).map_err(|error| {
            ConnectError::Unavailable(format!(
                "read {}; is the daemon running? {error}",
                paths.endpoint_file().display()
            ))
        })?;
        let endpoint: Endpoint = serde_json::from_str(&raw)
            .map_err(|error| ConnectError::Unavailable(format!("parse endpoint.json: {error}")))?;
        let admission = genet_daemon::transport::local::websocket_admission(
            endpoint.port,
            &endpoint.token,
            endpoint.pid,
            &endpoint.machine_id,
            &endpoint.fingerprint,
        );

        let (socket, _) = tokio_tungstenite::connect_async(&admission.url)
            .await
            // Keep transport internals out of the user error. The URL now holds
            // only a short-lived proof, but it is still an admission and not a
            // useful diagnostic.
            .map_err(|_| ConnectError::Unavailable(dial_failure(endpoint.port)))?;
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
                        let outcome = result_outcome(ok, payload, error);
                        let _ = sender.send(outcome);
                    }
                }
            }
            for (_, sender) in reader_pending.lock().await.drain() {
                let _ = sender.send(Err(RpcError::Transport("the connection closed".into())));
            }
        });

        let mut rpc = Self {
            outbound,
            pending,
            next_id: AtomicU64::new(1),
            reader,
            writer,
            hello: None,
        };
        let hello = match rpc
            .call(Request::Hello {
                client_name: format!("{}-cli", genet_daemon::channel::CLI_BINARY),
                protocol_version: PROTOCOL_VERSION,
                device: None,
                channel: None,
                invite: None,
            })
            .await
        {
            Ok(reply) => reply,
            Err(RpcError::Remote(error)) => return Err(ConnectError::Rejected(error)),
            Err(RpcError::Transport(message)) => {
                return Err(ConnectError::Unavailable(format!(
                    "Hello handshake: {message}"
                )))
            }
        };
        rpc.hello = match hello {
            Reply::Hello(hello) => {
                verify_local_hello(&hello, &admission)?;
                Some(hello)
            }
            other => {
                return Err(ConnectError::Protocol(format!(
                    "unexpected reply for Hello: {other:?}"
                )))
            }
        };
        Ok(rpc)
    }

    pub fn hello(&self) -> &HelloResult {
        self.hello
            .as_ref()
            .expect("Rpc is returned only after the Hello handshake")
    }

    pub async fn call(&self, request: Request) -> Result<Reply, RpcError> {
        let id = format!("c{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let mut envelope = serde_json::to_value(&request)
            .map_err(|error| RpcError::Transport(format!("encode request: {error}")))?;
        envelope
            .as_object_mut()
            .ok_or_else(|| RpcError::Transport("a request must encode as an object".into()))?
            .insert("id".into(), json!(&id));

        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);
        if self
            .outbound
            .send(Message::Text(envelope.to_string()))
            .is_err()
        {
            self.pending.lock().await.remove(&id);
            return Err(RpcError::Transport("the connection closed".into()));
        }

        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(Ok(reply))) => Ok(reply),
            Ok(Ok(Err(error))) => Err(error),
            Ok(Err(_)) => Err(RpcError::Transport(
                "the connection closed before answering".into(),
            )),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(RpcError::Transport("timed out waiting for a reply".into()))
            }
        }
    }
}

fn verify_local_hello(
    hello: &HelloResult,
    admission: &genet_daemon::transport::local::LocalWebSocketAdmission,
) -> Result<(), ConnectError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let proof_matches = hello.proof.as_deref().is_some_and(|presented| {
        genet_daemon::transport::auth::token_matches(&admission.server_proof, presented)
    });
    if admission.expires_at <= now
        || hello.protocol_version != PROTOCOL_VERSION
        || hello.transport != genehub_proto::TransportKind::Loopback
        || hello.machine_id != admission.machine_id
        || hello.fingerprint != admission.fingerprint
        || hello.server_nonce.is_some()
        || !proof_matches
    {
        return Err(ConnectError::Protocol(
            "the loopback listener did not prove the expected daemon identity".into(),
        ));
    }
    Ok(())
}

fn dial_failure(port: u16) -> String {
    format!("dial local daemon at loopback port {port} failed")
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
    machine_id: String,
    fingerprint: String,
    pid: u32,
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

fn result_outcome(
    ok: bool,
    payload: Option<Reply>,
    error: Option<ProtocolError>,
) -> Result<Reply, RpcError> {
    if ok {
        return Ok(payload.unwrap_or(Reply::Ack));
    }
    Err(match error {
        Some(error) => RpcError::Remote(error),
        None => RpcError::Transport("the daemon returned a failed result without an error".into()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{ErrorCode, TransportKind};

    fn local_contract() -> (
        genet_daemon::transport::local::LocalWebSocketAdmission,
        HelloResult,
    ) {
        let expires_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 10;
        let admission = genet_daemon::transport::local::LocalWebSocketAdmission {
            url: "ws://127.0.0.1:1/ws".into(),
            server_proof: "a".repeat(64),
            challenge: "b".repeat(64),
            pid: 42,
            machine_id: "m_local".into(),
            fingerprint: "fp-local".into(),
            expires_at,
        };
        let hello = HelloResult {
            daemon_version: "test".into(),
            protocol_version: PROTOCOL_VERSION,
            machine_id: admission.machine_id.clone(),
            fingerprint: admission.fingerprint.clone(),
            transport: TransportKind::Loopback,
            machine_name: "local".into(),
            proof: Some(admission.server_proof.clone()),
            server_nonce: None,
        };
        (admission, hello)
    }

    #[test]
    fn local_hello_requires_the_out_of_band_listener_proof_and_identity() {
        let (admission, hello) = local_contract();
        verify_local_hello(&hello, &admission).unwrap();

        let mut forged = hello.clone();
        forged.proof = Some("c".repeat(64));
        assert!(verify_local_hello(&forged, &admission).is_err());

        let mut wrong_machine = hello;
        wrong_machine.machine_id = "m_attacker".into();
        assert!(verify_local_hello(&wrong_machine, &admission).is_err());
    }

    #[test]
    fn expired_local_listener_proofs_are_rejected() {
        let (mut admission, hello) = local_contract();
        admission.expires_at = 1;
        assert!(verify_local_hello(&hello, &admission).is_err());
    }

    #[test]
    fn a_remote_error_keeps_its_typed_code_and_message() {
        let error = ProtocolError {
            code: ErrorCode::Forbidden,
            message: "outside the workspace".into(),
        };
        let outcome = result_outcome(false, None, Some(error.clone())).unwrap_err();

        assert_eq!(outcome, RpcError::Remote(error));
        assert_eq!(outcome.to_string(), "forbidden: outside the workspace");
    }

    #[test]
    fn a_success_without_a_payload_is_the_protocol_ack() {
        assert_eq!(result_outcome(true, None, None).unwrap(), Reply::Ack);
    }

    #[test]
    fn a_malformed_failed_result_is_not_mistaken_for_a_business_error() {
        assert!(matches!(
            result_outcome(false, None, None),
            Err(RpcError::Transport(_))
        ));
    }

    #[test]
    fn dial_errors_cannot_echo_the_loopback_bearer_token() {
        let sentinel = "full-local-daemon-secret";
        let message = dial_failure(43123);
        assert!(!message.contains(sentinel));
        assert!(!message.contains("token="));
        assert_eq!(message, "dial local daemon at loopback port 43123 failed");
    }
}
