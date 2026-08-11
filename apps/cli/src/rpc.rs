//! Protocol-v3 RPC client for the local daemon.
//!
//! Discovery mints a one-use loopback admission.  The only plaintext
//! application records are `PeerHello` and `PeerWelcome`; identity and every
//! command then use independent E2EE logical streams.

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use genehub_proto::{
    HelloResult, HubTicket, PeerAuth, PeerHello, PeerWelcome, ProtocolError, Reply, Request,
    SequencedEvent, ServerFrame,
};
use genet_daemon::config::Paths;
use genet_daemon::dataplane::client::ClientEndpoint;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

pub use genet_daemon::transport::fabric::Refusal;

use crate::machines::PairedMachine;
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
    /// The relay or the machine answered, and said no. Which kind of no is
    /// kept, because "that machine is asleep" and "that credential is no
    /// longer honoured" differ in whether waiting is worth anything.
    Refused {
        reason: Refusal,
        message: String,
    },
    Rejected(ProtocolError),
    Protocol(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Unavailable(message)
            | ConnectError::Protocol(message)
            | ConnectError::Refused { message, .. } => formatter.write_str(message),
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

    /// Connects to a machine this installation has already paired with.
    ///
    /// The relay in the middle is asked for a route and nothing else. It never
    /// learns whether this device is allowed in, because it could not answer:
    /// the authorized-device list lives on the machine being called.
    pub async fn connect_remote(machine: &PairedMachine) -> Result<Self, ConnectError> {
        let nonce = fresh_nonce();
        let context = genet_daemon::channel_auth::device_context(&machine.device_id);
        let auth = PeerAuth::Device {
            device_id: machine.device_id.clone(),
            nonce: nonce.clone(),
            proof: genet_daemon::channel_auth::client_proof(&machine.secret, &context, &nonce),
        };
        let rpc = Self::over_fabric(
            &machine.endpoint,
            route_of(&machine.endpoint)?,
            auth,
            &machine.secret,
            &context,
            &nonce,
        )
        .await?;
        verify_remote_identity(&rpc.hello, machine)?;
        Ok(rpc)
    }

    /// Connects with a capability a Hub issued for this machine.
    pub async fn connect_hosted(ticket: &HubTicket) -> Result<Self, ConnectError> {
        let nonce = fresh_nonce();
        let context = genet_daemon::channel_auth::hosted_context(&ticket.channel_capability);
        let auth = PeerAuth::Hosted {
            capability_id: ticket.channel_capability.clone(),
            nonce: nonce.clone(),
            proof: genet_daemon::channel_auth::client_proof(
                &ticket.channel_secret,
                &context,
                &nonce,
            ),
        };
        let rpc = Self::over_fabric(
            &ticket.url,
            &ticket.fabric_route_ticket,
            auth,
            &ticket.channel_secret,
            &context,
            &nonce,
        )
        .await?;
        // The Hub said which key this machine has, and the connection proved
        // one. Comparing them is the only reason asking the Hub was worth
        // anything: a Hub that lies gets caught here rather than believed.
        if !ticket.fingerprint.is_empty()
            && !rpc.hello.fingerprint.is_empty()
            && rpc.hello.fingerprint != ticket.fingerprint
        {
            return Err(ConnectError::Protocol(
                "the machine that answered is not the one the Hub named".into(),
            ));
        }
        Ok(rpc)
    }

    async fn over_fabric(
        endpoint: &str,
        route_ticket: &str,
        auth: PeerAuth,
        secret: &str,
        context: &str,
        nonce: &str,
    ) -> Result<Self, ConnectError> {
        let (data, monitor) = link_up(endpoint, route_ticket, auth, secret, context, nonce).await?;
        let hello = match rpc_call(&data, Request::ConnectionIdentity).await {
            Ok(Reply::Hello(hello)) => hello,
            Ok(other) => {
                return Err(ConnectError::Protocol(format!(
                    "unexpected identity reply: {other:?}"
                )))
            }
            Err(RpcError::Remote(error)) => return Err(ConnectError::Rejected(error)),
            Err(RpcError::Transport(message)) => return Err(ConnectError::Unavailable(message)),
        };
        Ok(Self {
            endpoint: data,
            tasks: Mutex::new(vec![monitor]),
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

/// The route a rendezvous URL is asking for.
///
/// Self-hosted endpoints carry it in the URL because that is the whole address
/// someone copies; a hosted ticket carries it separately, since the Hub issues
/// the route and the address independently.
fn route_of(endpoint: &str) -> Result<&str, ConnectError> {
    let query = endpoint
        .split_once('?')
        .map(|(_, query)| query)
        .unwrap_or("");
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("route="))
        .filter(|route| !route.is_empty())
        .ok_or_else(|| {
            ConnectError::Unavailable(
                "that endpoint names no route; a rendezvous URL is the one the machine printed"
                    .into(),
            )
        })
}

/// A connection that may do exactly one thing: redeem the invitation it was
/// opened with.
///
/// Its own type rather than an `Rpc` with a note attached, because the machine
/// refuses everything else on such a connection. A caller that cannot express
/// the mistake cannot make it.
pub struct Pairing {
    endpoint: ClientEndpoint,
    _link: tokio::task::JoinHandle<()>,
}

impl Pairing {
    /// Opens the narrow bootstrap connection an invitation authenticates.
    pub async fn open(endpoint: &str, invite_id: &str, secret: &str) -> Result<Self, ConnectError> {
        let nonce = fresh_nonce();
        let context = format!("invite:{invite_id}");
        let auth = PeerAuth::Invite {
            invite_id: invite_id.to_string(),
            nonce: nonce.clone(),
            proof: genet_daemon::channel_auth::client_proof(secret, &context, &nonce),
        };
        let (endpoint, link) = link_up(
            endpoint,
            route_of(endpoint)?,
            auth,
            secret,
            &context,
            &nonce,
        )
        .await?;
        Ok(Pairing {
            endpoint,
            _link: link,
        })
    }

    /// Redeems it. The claim names only the invitation's id: the handshake
    /// already proved the secret, and putting it on the wire a second time
    /// would risk it for nothing.
    pub async fn claim(
        &self,
        invite_id: &str,
        device_name: &str,
    ) -> Result<genehub_proto::DeviceCredential, RpcError> {
        match rpc_call(
            &self.endpoint,
            Request::DeviceClaim {
                code: invite_id.to_string(),
                device_name: device_name.to_string(),
            },
        )
        .await?
        {
            Reply::Claimed(credential) => Ok(credential),
            other => Err(RpcError::Transport(format!(
                "the machine answered the claim with {other:?}"
            ))),
        }
    }
}

/// Dials, proves both directions, and starts the encrypted endpoint.
///
/// The returned task owns the socket pumps, so the link lives exactly as long
/// as whoever is speaking over it.
async fn link_up(
    endpoint: &str,
    route_ticket: &str,
    auth: PeerAuth,
    secret: &str,
    context: &str,
    nonce: &str,
) -> Result<(ClientEndpoint, tokio::task::JoinHandle<()>), ConnectError> {
    let hello = PeerHello {
        version: genehub_proto::DATA_PLANE_VERSION,
        client_name: format!("{}-cli", genet_daemon::channel::CLI_BINARY),
        auth,
        rtc_supported: false,
    };
    let link = genet_daemon::transport::fabric::dial(endpoint, route_ticket, &hello)
        .await
        .map_err(dial_refusal)?;
    if link.welcome.version != genehub_proto::DATA_PLANE_VERSION {
        return Err(ConnectError::Protocol(
            "that machine uses a different data-plane version".into(),
        ));
    }
    // The proof is what makes the relay uninteresting: whoever is holding the
    // other end of this route either knows the secret or does not, and
    // occupying the slot in front of the machine proves nothing.
    let expected = genet_daemon::channel_auth::server_proof(
        secret,
        context,
        nonce,
        &link.welcome.server_nonce,
    );
    genet_daemon::channel_auth::verify_proof(&expected, &link.welcome.proof).map_err(|_| {
        ConnectError::Protocol(
            "whoever answered at that address could not prove the expected secret".into(),
        )
    })?;
    let key =
        genet_daemon::channel_auth::derive_key(secret, context, nonce, &link.welcome.server_nonce);
    let genet_daemon::transport::fabric::FabricLink { carrier, pump, .. } = link;
    let (data, endpoint_task) = ClientEndpoint::start(key, carrier);
    let monitor = tokio::spawn(async move {
        let _ = endpoint_task.await;
        drop(pump);
    });
    Ok((data, monitor))
}

/// Keeps the dialer's distinction between "not now" and "not you".
fn dial_refusal(error: genet_daemon::transport::fabric::DialError) -> ConnectError {
    use genet_daemon::transport::fabric::DialError;
    match error {
        DialError::Refused { reason, message } => ConnectError::Refused { reason, message },
        DialError::Unavailable(message) => ConnectError::Unavailable(message),
        DialError::Protocol(message) => ConnectError::Protocol(message),
    }
}

/// The 16 random bytes a peer challenge has to be.
fn fresh_nonce() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// Checks that the machine that answered is the one that was called.
///
/// A mutually authenticated identity withholds the machine's public fields —
/// the key exchange already proved who this is, and repeating them would tell
/// a relay who is on the other end. Only a filled-in field is checked.
fn verify_remote_identity(
    hello: &HelloResult,
    machine: &PairedMachine,
) -> Result<(), ConnectError> {
    if hello.protocol_version != genehub_proto::DATA_PLANE_VERSION {
        return Err(ConnectError::Protocol(format!(
            "{} speaks data plane {}, this build speaks {}",
            machine.machine_id,
            hello.protocol_version,
            genehub_proto::DATA_PLANE_VERSION
        )));
    }
    if !hello.machine_id.is_empty() && hello.machine_id != machine.machine_id {
        return Err(ConnectError::Protocol(format!(
            "expected {}, but {} answered",
            machine.machine_id, hello.machine_id
        )));
    }
    if !hello.fingerprint.is_empty() && hello.fingerprint != machine.fingerprint {
        return Err(ConnectError::Protocol(format!(
            "{} answered with a different identity key than it had when it was paired",
            machine.machine_id
        )));
    }
    Ok(())
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
        IsolationUnavailable => "isolation_unavailable",
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
            isolation: None,
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
