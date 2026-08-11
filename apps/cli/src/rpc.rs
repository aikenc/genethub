//! Protocol-v3 RPC client for the local daemon.
//!
//! Discovery mints a one-use loopback admission.  The only plaintext
//! application records are `PeerHello` and `PeerWelcome`; identity and every
//! command then use independent E2EE logical streams.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use genehub_proto::{
    HelloResult, PeerAuth, PeerHello, PeerWelcome, ProtocolError, Reply, Request, SequencedEvent,
    ServerFrame,
};
use genet_daemon::config::Paths;
use genet_daemon::dataplane::client::ClientEndpoint;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

use crate::{fail, EXIT_UNREACHABLE};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// One event frame. Generous next to any single session event and bounded so a
/// malformed length cannot make the client allocate on request.
const MAX_EVENT_FRAME_BYTES: usize = 1024 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq)]
pub enum RpcError {
    Remote(ProtocolError),
    Transport(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RpcError::Remote(error) => write!(
                formatter,
                "{}: {}",
                error_code_name(error.code),
                error.message
            ),
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
    endpoint: ClientEndpoint,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    hello: HelloResult,
    /// Absent until someone asks to watch. A one-shot command opens no event
    /// stream, and the daemon allows one per peer.
    events: Mutex<Option<mpsc::UnboundedReceiver<Payload>>>,
}

impl Rpc {
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
        let endpoint_file: EndpointFile = serde_json::from_str(&raw)
            .map_err(|error| ConnectError::Unavailable(format!("parse endpoint.json: {error}")))?;
        let admission = genet_daemon::transport::local::websocket_admission(
            endpoint_file.port,
            &endpoint_file.token,
            endpoint_file.pid,
            &endpoint_file.machine_id,
            &endpoint_file.fingerprint,
        );

        let (mut socket, _) = tokio_tungstenite::connect_async(&admission.url)
            .await
            .map_err(|_| ConnectError::Unavailable(dial_failure(endpoint_file.port)))?;
        let nonce = genet_daemon::devices::random_token();
        let context = "loopback";
        let hello = PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: format!("{}-cli", genet_daemon::channel::CLI_BINARY),
            auth: PeerAuth::Loopback {
                context: context.into(),
                nonce: nonce.clone(),
                proof: genet_daemon::channel_auth::client_proof(
                    &admission.server_proof,
                    context,
                    &nonce,
                ),
            },
            rtc_supported: false,
        };
        timeout_send(
            &mut socket,
            Message::Binary(serde_json::to_vec(&hello).unwrap()),
        )
        .await?;
        let welcome_wire = tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.next())
            .await
            .map_err(|_| ConnectError::Unavailable("data-plane handshake timed out".into()))?
            .ok_or_else(|| {
                ConnectError::Unavailable("daemon closed during data-plane handshake".into())
            })?
            .map_err(|_| {
                ConnectError::Unavailable("daemon rejected the data-plane handshake".into())
            })?;
        let Message::Binary(welcome_wire) = welcome_wire else {
            return Err(ConnectError::Protocol(
                "daemon returned a non-binary data-plane welcome".into(),
            ));
        };
        let welcome: PeerWelcome = serde_json::from_slice(&welcome_wire).map_err(|_| {
            ConnectError::Protocol("daemon returned an invalid data-plane welcome".into())
        })?;
        if welcome.version != genehub_proto::DATA_PLANE_VERSION {
            return Err(ConnectError::Protocol(
                "daemon uses a different data-plane version".into(),
            ));
        }
        let expected = genet_daemon::channel_auth::server_proof(
            &admission.server_proof,
            context,
            &nonce,
            &welcome.server_nonce,
        );
        genet_daemon::channel_auth::verify_proof(&expected, &welcome.proof).map_err(|_| {
            ConnectError::Protocol("daemon did not prove the expected loopback identity".into())
        })?;
        let key = genet_daemon::channel_auth::derive_key(
            &admission.server_proof,
            context,
            &nonce,
            &welcome.server_nonce,
        );

        let (mut sink, mut stream) = socket.split();
        let (inbound, mut outbound, carrier) =
            genet_daemon::dataplane::endpoint::carrier_channels();
        let writer = tokio::spawn(async move {
            while let Some(record) = outbound.recv().await {
                if sink.send(Message::Binary(record)).await.is_err() {
                    break;
                }
            }
        });
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                match message {
                    Message::Binary(record)
                        if record.len() <= genehub_proto::MAX_DATA_FRAME_BYTES =>
                    {
                        if inbound.send(record.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => break,
                }
            }
        });
        let (data, endpoint_task) = ClientEndpoint::start(key, carrier);
        let endpoint_monitor = tokio::spawn(async move {
            let _ = endpoint_task.await;
        });
        let identity = rpc_call(&data, Request::ConnectionIdentity)
            .await
            .map_err(|error| match error {
                RpcError::Remote(error) => ConnectError::Rejected(error),
                RpcError::Transport(message) => ConnectError::Unavailable(message),
            })?;
        let hello = match identity {
            Reply::Hello(hello) => hello,
            other => {
                return Err(ConnectError::Protocol(format!(
                    "unexpected identity reply: {other:?}"
                )))
            }
        };
        verify_local_identity(&hello, &admission)?;
        Ok(Self {
            endpoint: data,
            tasks: Mutex::new(vec![writer, reader, endpoint_monitor]),
            hello,
            events: Mutex::new(None),
        })
    }

    pub fn hello(&self) -> &HelloResult {
        &self.hello
    }

    pub async fn call(&self, request: Request) -> Result<Reply, RpcError> {
        rpc_call(&self.endpoint, request).await
    }

    /// Starts receiving this peer's event frames.
    ///
    /// Opened before subscribing, never after: the daemon starts queueing a
    /// session's events the moment it accepts the subscription, and a stream
    /// opened afterwards would be a race whose loser is a missing turn.
    pub async fn watch_events(&self) -> Result<(), RpcError> {
        let mut events = self.events.lock().await;
        if events.is_some() {
            return Ok(());
        }
        let mut stream = self
            .endpoint
            .open_stream("events", Value::Null, Vec::new(), None)
            .await
            .map_err(|error| RpcError::Transport(format!("open the event stream: {error:#}")))?;
        let head = stream
            .response_head()
            .await
            .map_err(|error| RpcError::Transport(format!("event stream head: {error:#}")))?;
        if let Some(error) = head.error {
            return Err(RpcError::Remote(error));
        }
        if head.status != 200 {
            return Err(RpcError::Transport(format!(
                "the daemon answered the event stream with status {}",
                head.status
            )));
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        let reader = tokio::spawn(async move {
            let mut buffered = Vec::<u8>::new();
            while let Some(Ok(chunk)) = stream.next_chunk().await {
                buffered.extend_from_slice(&chunk);
                while let Some(frame) = take_frame(&mut buffered) {
                    // Only session traffic. A terminal belongs to whoever is
                    // watching one, and this client is not.
                    if let ServerFrame::Event { payload, .. } = frame {
                        if sender.send(Payload::Event(payload)).is_err() {
                            return;
                        }
                    } else if let ServerFrame::Desync { session_id, missed } = frame {
                        if sender.send(Payload::Desync { session_id, missed }).is_err() {
                            return;
                        }
                    }
                }
            }
        });
        *events = Some(receiver);
        self.tasks.lock().await.push(reader);
        Ok(())
    }

    /// The next session frame, or `None` once the stream is over.
    pub async fn next_event(&self) -> Option<Payload> {
        let mut events = self.events.lock().await;
        events.as_mut()?.recv().await
    }
}

/// What arrives on the event stream that a conversation cares about.
#[derive(Debug, Clone, PartialEq)]
pub enum Payload {
    Event(SequencedEvent),
    /// The daemon dropped frames for this session; what follows is not
    /// continuous with what came before.
    Desync {
        session_id: String,
        missed: u64,
    },
}

/// Splits one `u32`-length-prefixed JSON frame off the front of the buffer.
fn take_frame(buffered: &mut Vec<u8>) -> Option<ServerFrame> {
    if buffered.len() < 4 {
        return None;
    }
    let length = u32::from_be_bytes(buffered[..4].try_into().ok()?) as usize;
    if length == 0 || length > MAX_EVENT_FRAME_BYTES {
        buffered.clear();
        return None;
    }
    if buffered.len() < 4 + length {
        return None;
    }
    let frame = serde_json::from_slice::<ServerFrame>(&buffered[4..4 + length]).ok();
    buffered.drain(..4 + length);
    frame
}

async fn rpc_call(endpoint: &ClientEndpoint, request: Request) -> Result<Reply, RpcError> {
    let body = serde_json::to_vec(&request)
        .map_err(|error| RpcError::Transport(format!("encode request: {error}")))?;
    let response = tokio::time::timeout(
        CALL_TIMEOUT,
        endpoint.exchange(
            "rpc",
            Value::Null,
            body,
            Some(CALL_TIMEOUT.as_millis() as u32),
        ),
    )
    .await
    .map_err(|_| RpcError::Transport("timed out waiting for a reply".into()))?
    .map_err(|error| RpcError::Transport(format!("data-plane RPC failed: {error:#}")))?;
    if let Some(error) = response.head.error {
        return Err(RpcError::Remote(error));
    }
    if response.head.status != 200 {
        return Err(RpcError::Transport(format!(
            "daemon returned HTTP-like status {} without a protocol error",
            response.head.status
        )));
    }
    serde_json::from_slice(&response.body)
        .map_err(|error| RpcError::Transport(format!("decode reply: {error}")))
}

async fn timeout_send<S>(socket: &mut S, message: Message) -> Result<(), ConnectError>
where
    S: futures_util::Sink<Message> + Unpin,
{
    tokio::time::timeout(HANDSHAKE_TIMEOUT, socket.send(message))
        .await
        .map_err(|_| ConnectError::Unavailable("data-plane handshake timed out".into()))?
        .map_err(|_| ConnectError::Unavailable("daemon closed during data-plane handshake".into()))
}

fn verify_local_identity(
    hello: &HelloResult,
    admission: &genet_daemon::transport::local::LocalWebSocketAdmission,
) -> Result<(), ConnectError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    if admission.expires_at <= now
        || hello.protocol_version != genehub_proto::DATA_PLANE_VERSION
        || hello.transport != genehub_proto::TransportKind::Loopback
        || hello.machine_id != admission.machine_id
        || hello.fingerprint != admission.fingerprint
    {
        return Err(ConnectError::Protocol(
            "the loopback listener returned an inconsistent daemon identity".into(),
        ));
    }
    Ok(())
}

fn dial_failure(port: u16) -> String {
    format!("dial local daemon at loopback port {port} failed")
}

impl Drop for Rpc {
    fn drop(&mut self) {
        if let Ok(tasks) = self.tasks.try_lock() {
            for task in tasks.iter() {
                task.abort();
            }
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct EndpointFile {
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
            protocol_version: genehub_proto::DATA_PLANE_VERSION,
            machine_id: admission.machine_id.clone(),
            fingerprint: admission.fingerprint.clone(),
            transport: TransportKind::Loopback,
            machine_name: "local".into(),
            rtc_supported: true,
        };
        (admission, hello)
    }

    #[test]
    fn local_identity_must_match_the_out_of_band_admission() {
        let (admission, hello) = local_contract();
        verify_local_identity(&hello, &admission).unwrap();
        let mut wrong = hello;
        wrong.machine_id = "m_attacker".into();
        assert!(verify_local_identity(&wrong, &admission).is_err());
    }

    #[test]
    fn a_remote_error_keeps_its_typed_code_and_message() {
        let error = ProtocolError {
            code: ErrorCode::Forbidden,
            message: "outside the workspace".into(),
        };
        let outcome = RpcError::Remote(error.clone());
        assert_eq!(outcome, RpcError::Remote(error));
        assert_eq!(outcome.to_string(), "forbidden: outside the workspace");
    }

    #[test]
    fn dial_errors_do_not_echo_the_loopback_bearer() {
        let message = dial_failure(43123);
        assert!(!message.contains("token="));
        assert_eq!(message, "dial local daemon at loopback port 43123 failed");
    }
}
