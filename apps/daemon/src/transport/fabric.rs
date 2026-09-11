//! Endpoint-neutral Fabric v2 uplink.
//!
//! Relay routes one opaque outer stream to this node. That stream carries one
//! mutually authenticated v3 peer link; the peer link then multiplexes all
//! business exchanges with its own bounded, fair frames.

use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{PeerAuth, PeerHello, TransportKind};
use tokio::sync::{mpsc, Notify};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Enrollment;
use crate::dataplane::{endpoint, handshake};
use crate::state::Shared;
use crate::transport::admission::Admission;
use crate::transport::ws;

const VERSION: u8 = 2;
const HEADER_BYTES: usize = 28;
const STREAM_ID_BYTES: usize = 16;
const MAX_WIRE_FRAME_BYTES: usize = genehub_proto::MAX_DATA_FRAME_BYTES + HEADER_BYTES;
const INITIAL_CREDIT: u64 = genehub_proto::INITIAL_STREAM_WINDOW_BYTES as u64;
const TRANSPORT_FLOW: &str = "transport-v1";
const MAX_PEERS: usize = 32;
const MAX_PENDING: usize = 8;
const WRITER_QUEUE: usize = 256;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// Matches the browser half of this wire (`packages/workbench/src/fabric/frame.ts`).
const MAX_ROUTE_TICKET_BYTES: usize = 4096;
const BACKOFF: [u64; 6] = [1, 2, 5, 10, 30, 60];

/// The same bounds on both ends of every Fabric socket. One outer stream
/// carries every peer link this node has, so a frame limit that differed
/// between the uplink and the dialer would be a limit that only some of the
/// traffic obeyed.
fn socket_config() -> WebSocketConfig {
    WebSocketConfig {
        max_write_buffer_size: 512 * 1024,
        max_message_size: Some(MAX_WIRE_FRAME_BYTES),
        max_frame_size: Some(MAX_WIRE_FRAME_BYTES),
        ..WebSocketConfig::default()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum Kind {
    Open = 1,
    Incoming = 2,
    Accept = 3,
    Data = 4,
    WindowUpdate = 5,
    Fin = 6,
    Reset = 7,
    Ping = 8,
    Pong = 9,
}

#[derive(Clone)]
struct Frame {
    kind: Kind,
    stream_id: [u8; STREAM_ID_BYTES],
    value: u64,
    payload: Vec<u8>,
}

#[derive(Clone)]
struct Writer {
    messages: mpsc::Sender<Message>,
}

impl Writer {
    async fn frame(&self, frame: Frame) -> Result<()> {
        self.messages
            .send(Message::Binary(encode(&frame)?))
            .await
            .map_err(|_| anyhow!("Fabric socket writer stopped"))
    }

    async fn reset(&self, stream_id: [u8; STREAM_ID_BYTES], code: u64) {
        let _ = self
            .frame(Frame {
                kind: Kind::Reset,
                stream_id,
                value: code,
                payload: Vec::new(),
            })
            .await;
    }
}

#[derive(Clone)]
struct Credit {
    inner: Arc<CreditInner>,
}

struct CreditInner {
    value: Mutex<u64>,
    maximum: u64,
    notify: Notify,
}

impl Credit {
    fn new(value: u64) -> Result<Self> {
        if value == 0 || value > genehub_proto::INITIAL_STREAM_WINDOW_BYTES as u64 {
            anyhow::bail!("invalid Fabric stream credit");
        }
        Ok(Self {
            inner: Arc::new(CreditInner {
                value: Mutex::new(value),
                maximum: value,
                notify: Notify::new(),
            }),
        })
    }

    async fn take(&self, bytes: usize) -> Result<()> {
        let bytes = u64::try_from(bytes)?;
        if bytes == 0 || bytes > self.inner.maximum {
            anyhow::bail!("Fabric record does not fit its stream window");
        }
        loop {
            let notified = self.inner.notify.notified();
            {
                let mut value = self.inner.value.lock().unwrap();
                if *value >= bytes {
                    *value -= bytes;
                    return Ok(());
                }
            }
            notified.await;
        }
    }

    fn add(&self, value: u64) -> bool {
        if value == 0 {
            return false;
        }
        let mut current = self.inner.value.lock().unwrap();
        let Some(next) = current.checked_add(value) else {
            return false;
        };
        if next > self.inner.maximum {
            return false;
        }
        *current = next;
        drop(current);
        self.inner.notify.notify_waiters();
        true
    }
}

#[derive(Clone)]
enum StreamFlow {
    Legacy(Credit),
    /// DATA follows only local bounded queues and the TCP/WebSocket drain.
    Transport,
}

impl StreamFlow {
    fn from_wire(value: u64) -> Result<Self> {
        if value == 0 {
            Ok(Self::Transport)
        } else {
            Credit::new(value).map(Self::Legacy)
        }
    }

    async fn take(&self, bytes: usize) -> Result<()> {
        match self {
            Self::Legacy(credit) => credit.take(bytes).await,
            Self::Transport if bytes > 0 => Ok(()),
            Self::Transport => anyhow::bail!("Fabric record cannot be empty"),
        }
    }

    fn add(&self, value: u64) -> bool {
        match self {
            Self::Legacy(credit) => credit.add(value),
            Self::Transport => false,
        }
    }

    fn is_transport(&self) -> bool {
        matches!(self, Self::Transport)
    }
}

struct PeerSlot {
    generation: u64,
    inbound: mpsc::Sender<Vec<u8>>,
    remote_sequence: u64,
    outbound_flow: StreamFlow,
}

type Peers = Arc<tokio::sync::Mutex<HashMap<[u8; STREAM_ID_BYTES], PeerSlot>>>;
type Pending = Arc<tokio::sync::Mutex<HashSet<[u8; STREAM_ID_BYTES]>>>;

pub struct FabricUplink {
    task: tokio::task::JoinHandle<()>,
    online: Arc<AtomicBool>,
}

impl FabricUplink {
    /// Managed Hub: refresh the one-use endpoint admission before every dial
    /// and redeem every incoming peer capability directly with Control.
    pub fn start(state: Shared, enrollment: Enrollment) -> Self {
        let online = Arc::new(AtomicBool::new(false));
        let task_online = online.clone();
        let task = tokio::spawn(async move {
            let client = crate::hub::Client::new(&enrollment.hub_url);
            let mut attempt = 0usize;
            loop {
                let result = async {
                    let admission = client.fabric_admission(&enrollment).await?;
                    run_once(
                        state.clone(),
                        &admission.url,
                        PeerAdmissionSource::Hosted(enrollment.clone()),
                        &task_online,
                        "managed.uplink",
                    )
                    .await
                }
                .await;
                task_online.store(false, Ordering::Relaxed);
                state.diagnostics.record(
                    "fabric",
                    "managed.uplink",
                    "offline",
                    Some(if result.is_err() {
                        "connection"
                    } else {
                        "closed"
                    }),
                );
                if let Err(error) = result {
                    tracing::warn!(%error, "Fabric uplink disconnected");
                }
                let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
                attempt = (attempt + 1).min(BACKOFF.len() - 1);
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
        });
        Self { task, online }
    }

    /// Self-hosted rendezvous: the endpoint admission is reusable routing
    /// material, while authority remains the daemon's paired-device list.
    pub fn start_rendezvous(state: Shared, url: String) -> Self {
        let online = Arc::new(AtomicBool::new(false));
        let task_online = online.clone();
        let task = tokio::spawn(async move {
            let mut attempt = 0usize;
            loop {
                let result = run_once(
                    state.clone(),
                    &url,
                    PeerAdmissionSource::DeviceRequired,
                    &task_online,
                    "rendezvous.uplink",
                )
                .await;
                task_online.store(false, Ordering::Relaxed);
                state.diagnostics.record(
                    "fabric",
                    "rendezvous.uplink",
                    "offline",
                    Some(if result.is_err() {
                        "connection"
                    } else {
                        "closed"
                    }),
                );
                if let Err(error) = result {
                    tracing::warn!(%error, "rendezvous Fabric uplink disconnected");
                }
                let delay = BACKOFF[attempt.min(BACKOFF.len() - 1)];
                attempt = (attempt + 1).min(BACKOFF.len() - 1);
                tokio::time::sleep(Duration::from_secs(delay)).await;
            }
        });
        Self { task, online }
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.task.abort();
        self.online.store(false, Ordering::Relaxed);
    }
}

async fn run_once(
    state: Shared,
    url: &str,
    admission_source: PeerAdmissionSource,
    online: &AtomicBool,
    diagnostic_operation: &'static str,
) -> Result<()> {
    let endpoint_url = transport_flow_url(url)?;
    validate_fabric_url(&endpoint_url)?;
    tracing::debug!(url = %endpoint_url, "dialing the Fabric relay");
    let socket = tokio::time::timeout(CONNECT_TIMEOUT, ws::connect(&endpoint_url, socket_config()))
        .await
        .context("Fabric WebSocket handshake timed out")??;
    online.store(true, Ordering::Relaxed);
    state
        .diagnostics
        .record("fabric", diagnostic_operation, "online", None);
    tracing::info!("Fabric v2 uplink established");

    let (mut sink, mut source) = socket.split();
    let (messages_tx, mut messages_rx) = mpsc::channel::<Message>(WRITER_QUEUE);
    let writer = Writer {
        messages: messages_tx.clone(),
    };
    let socket_writer = tokio::spawn(async move {
        while let Some(message) = messages_rx.recv().await {
            sink.send(message).await?;
        }
        Result::<()>::Ok(())
    });
    let peers: Peers = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let pending: Pending = Arc::new(tokio::sync::Mutex::new(HashSet::new()));
    let generation = Arc::new(AtomicU64::new(0));
    let tasks = Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let read_result = async {
        while let Some(message) = source.next().await {
            match message? {
                Message::Binary(bytes) => {
                    let frame = decode(&bytes).ok_or_else(|| anyhow!("malformed Fabric frame"))?;
                    receive(
                        frame,
                        &state,
                        &admission_source,
                        &writer,
                        &peers,
                        &pending,
                        &generation,
                        &tasks,
                    )
                    .await?;
                }
                Message::Ping(payload) => {
                    messages_tx
                        .send(Message::Pong(payload))
                        .await
                        .map_err(|_| anyhow!("Fabric writer stopped"))?;
                }
                Message::Close(_) => break,
                Message::Text(_) => anyhow::bail!("Fabric sent a text WebSocket message"),
                _ => {}
            }
        }
        Result::<()>::Ok(())
    }
    .await;

    online.store(false, Ordering::Relaxed);
    peers.lock().await.clear();
    for task in tasks.lock().await.drain(..) {
        task.abort();
    }
    socket_writer.abort();
    read_result?;
    anyhow::bail!("Fabric WebSocket ended")
}

#[allow(clippy::too_many_arguments)]
async fn receive(
    frame: Frame,
    state: &Shared,
    admission_source: &PeerAdmissionSource,
    writer: &Writer,
    peers: &Peers,
    pending: &Pending,
    generation: &Arc<AtomicU64>,
    tasks: &Arc<tokio::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>>,
) -> Result<()> {
    match frame.kind {
        Kind::Incoming => {
            if frame.stream_id == [0; STREAM_ID_BYTES]
                || frame.value > INITIAL_CREDIT
                || frame.payload.is_empty()
                || frame.payload.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES
            {
                writer.reset(frame.stream_id, 3).await;
                return Ok(());
            }
            {
                let peers = peers.lock().await;
                let mut pending = pending.lock().await;
                if peers.contains_key(&frame.stream_id)
                    || pending.contains(&frame.stream_id)
                    || peers.len() + pending.len() >= MAX_PEERS
                    || pending.len() >= MAX_PENDING
                {
                    drop(pending);
                    drop(peers);
                    writer.reset(frame.stream_id, 10).await;
                    return Ok(());
                }
                pending.insert(frame.stream_id);
            }
            let peer_generation = generation.fetch_add(1, Ordering::Relaxed) + 1;
            let task = tokio::spawn(serve_peer(
                state.clone(),
                admission_source.clone(),
                writer.clone(),
                peers.clone(),
                pending.clone(),
                frame,
                peer_generation,
            ));
            let mut tasks = tasks.lock().await;
            tasks.retain(|task| !task.is_finished());
            tasks.push(task);
        }
        Kind::Data => {
            let bytes = u64::try_from(frame.payload.len())?;
            let (inbound, peer_generation, transport_flow) = {
                let mut peers = peers.lock().await;
                let Some(slot) = peers.get_mut(&frame.stream_id) else {
                    drop(peers);
                    writer.reset(frame.stream_id, 1).await;
                    return Ok(());
                };
                if bytes == 0 || frame.value != slot.remote_sequence + 1 {
                    peers.remove(&frame.stream_id);
                    drop(peers);
                    writer.reset(frame.stream_id, 6).await;
                    return Ok(());
                }
                slot.remote_sequence = frame.value;
                (
                    slot.inbound.clone(),
                    slot.generation,
                    slot.outbound_flow.is_transport(),
                )
            };
            // A full bounded carrier queue is backpressure, not a protocol
            // violation. Waiting here also stops this socket reader from
            // acknowledging bytes it has nowhere bounded to place.
            if inbound.send(frame.payload).await.is_err() {
                let mut peers = peers.lock().await;
                if peers
                    .get(&frame.stream_id)
                    .is_some_and(|slot| slot.generation == peer_generation)
                {
                    peers.remove(&frame.stream_id);
                }
                drop(peers);
                writer.reset(frame.stream_id, 6).await;
                return Ok(());
            }
            // The bounded carrier queue accepted ownership, so this outer
            // stream can return exactly the credit it consumed.
            if !transport_flow {
                let update = Frame {
                    kind: Kind::WindowUpdate,
                    stream_id: frame.stream_id,
                    value: bytes,
                    payload: Vec::new(),
                };
                writer.frame(update).await?;
            }
        }
        Kind::WindowUpdate => {
            if !frame.payload.is_empty() || frame.value == 0 {
                anyhow::bail!("invalid Fabric WINDOW_UPDATE");
            }
            let peers = peers.lock().await;
            let Some(slot) = peers.get(&frame.stream_id) else {
                drop(peers);
                writer.reset(frame.stream_id, 1).await;
                return Ok(());
            };
            if !slot.outbound_flow.add(frame.value) {
                anyhow::bail!("Fabric peer exceeded its credit window");
            }
        }
        Kind::Fin | Kind::Reset => {
            peers.lock().await.remove(&frame.stream_id);
        }
        Kind::Ping => {
            if frame.stream_id != [0; STREAM_ID_BYTES] || !frame.payload.is_empty() {
                anyhow::bail!("invalid Fabric PING");
            }
            writer
                .frame(Frame {
                    kind: Kind::Pong,
                    ..frame
                })
                .await?;
        }
        Kind::Pong => {}
        Kind::Open | Kind::Accept => anyhow::bail!("invalid frame for a Fabric node endpoint"),
    }
    Ok(())
}

async fn serve_peer(
    state: Shared,
    admission_source: PeerAdmissionSource,
    writer: Writer,
    peers: Peers,
    pending: Pending,
    frame: Frame,
    generation: u64,
) {
    let result = serve_peer_inner(
        state,
        &admission_source,
        &writer,
        &peers,
        &pending,
        &frame,
        generation,
    )
    .await;
    pending.lock().await.remove(&frame.stream_id);
    if let Err(error) = result {
        tracing::debug!(%error, "Fabric peer stream refused");
        writer.reset(frame.stream_id, 4).await;
    }
    let mut peers = peers.lock().await;
    if peers
        .get(&frame.stream_id)
        .is_some_and(|slot| slot.generation == generation)
    {
        peers.remove(&frame.stream_id);
    }
}

async fn serve_peer_inner(
    state: Shared,
    admission_source: &PeerAdmissionSource,
    writer: &Writer,
    peers: &Peers,
    pending: &Pending,
    frame: &Frame,
    generation: u64,
) -> Result<()> {
    let hello: PeerHello =
        serde_json::from_slice(&frame.payload).context("invalid Fabric peer hello")?;
    let admitted = admission_source.resolve(&hello).await?;
    let accepted = handshake::accept(
        &state,
        TransportKind::Forwarded,
        admitted.admission,
        &frame.payload,
        admitted.local_workspace_id,
        admitted.workspace_handle,
    )?;
    let (inbound, mut outbound, carrier) = endpoint::carrier_channels();
    let flow = StreamFlow::from_wire(frame.value)?;
    peers.lock().await.insert(
        frame.stream_id,
        PeerSlot {
            generation,
            inbound,
            remote_sequence: 0,
            outbound_flow: flow.clone(),
        },
    );
    pending.lock().await.remove(&frame.stream_id);
    writer
        .frame(Frame {
            kind: Kind::Accept,
            stream_id: frame.stream_id,
            value: if flow.is_transport() {
                0
            } else {
                INITIAL_CREDIT
            },
            payload: serde_json::to_vec(&accepted.welcome)?,
        })
        .await?;

    let peer_writer = writer.clone();
    let stream_id = frame.stream_id;
    let mut outgoing = tokio::spawn(async move {
        let mut sequence = 0u64;
        while let Some(record) = outbound.recv().await {
            if record.is_empty() || record.len() > genehub_proto::MAX_DATA_FRAME_BYTES {
                anyhow::bail!("data-plane record exceeds the Fabric bound");
            }
            flow.take(record.len()).await?;
            sequence = sequence
                .checked_add(1)
                .context("Fabric sequence exhausted")?;
            peer_writer
                .frame(Frame {
                    kind: Kind::Data,
                    stream_id,
                    value: sequence,
                    payload: record,
                })
                .await?;
        }
        Result::<()>::Ok(())
    });
    let mut endpoint = tokio::spawn(endpoint::serve(
        state,
        accepted.key,
        accepted.access,
        carrier,
        endpoint::CarrierKind::Fabric,
    ));
    let expiry = async move {
        match admitted.expires_at {
            Some(expires_at) => {
                tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)).await
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::pin!(expiry);
    let result = tokio::select! {
        result = &mut endpoint => result.context("Fabric data endpoint stopped")?,
        result = &mut outgoing => result.context("Fabric peer writer stopped")?,
        _ = &mut expiry => Err(anyhow!("Fabric route expired")),
    };
    endpoint.abort();
    outgoing.abort();
    result
}

#[derive(Clone)]
enum PeerAdmissionSource {
    Hosted(Enrollment),
    DeviceRequired,
}

struct ResolvedPeerAdmission {
    admission: Admission,
    workspace_handle: Option<String>,
    local_workspace_id: Option<String>,
    expires_at: Option<std::time::Instant>,
}

impl PeerAdmissionSource {
    async fn resolve(&self, hello: &PeerHello) -> Result<ResolvedPeerAdmission> {
        match self {
            Self::Hosted(enrollment) => {
                let capability_id = match &hello.auth {
                    PeerAuth::Hosted { capability_id, .. } => capability_id.clone(),
                    _ => anyhow::bail!("Fabric peer did not present a hosted capability"),
                };
                let admitted = crate::hub::Client::new(&enrollment.hub_url)
                    .fabric_peer_admission(enrollment, &capability_id)
                    .await?
                    .ok_or_else(|| anyhow!("Fabric peer capability was refused"))?;
                let expires_at = admitted.expires_at;
                Ok(ResolvedPeerAdmission {
                    admission: Admission::Fabric {
                        capability_id,
                        secret: admitted.secret,
                        expires_at,
                    },
                    workspace_handle: admitted.workspace_handle,
                    local_workspace_id: admitted.local_workspace_id,
                    expires_at: Some(expires_at),
                })
            }
            Self::DeviceRequired => {
                if !matches!(
                    hello.auth,
                    PeerAuth::Device { .. } | PeerAuth::Invite { .. }
                ) {
                    anyhow::bail!("rendezvous peers must present a daemon-issued credential");
                }
                Ok(ResolvedPeerAdmission {
                    admission: Admission::DeviceRequired,
                    workspace_handle: None,
                    local_workspace_id: None,
                    // The outer Fabric route owns its lifetime. There is no
                    // Control lease in the self-hosted model.
                    expires_at: None,
                })
            }
        }
    }
}

fn encode(frame: &Frame) -> Result<Vec<u8>> {
    let control = matches!(frame.kind, Kind::Ping | Kind::Pong);
    if control != (frame.stream_id == [0; STREAM_ID_BYTES]) {
        anyhow::bail!("invalid Fabric stream id class");
    }
    if HEADER_BYTES + frame.payload.len() > MAX_WIRE_FRAME_BYTES {
        anyhow::bail!("Fabric frame exceeds its wire bound");
    }
    let mut out = Vec::with_capacity(HEADER_BYTES + frame.payload.len());
    out.push(VERSION);
    out.push(frame.kind as u8);
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&frame.stream_id);
    out.extend_from_slice(&frame.value.to_be_bytes());
    out.extend_from_slice(&frame.payload);
    Ok(out)
}

fn decode(bytes: &[u8]) -> Option<Frame> {
    if bytes.len() < HEADER_BYTES || bytes.len() > MAX_WIRE_FRAME_BYTES || bytes[0] != VERSION {
        return None;
    }
    if u16::from_be_bytes(bytes[2..4].try_into().ok()?) != 0 {
        return None;
    }
    let kind = match bytes[1] {
        1 => Kind::Open,
        2 => Kind::Incoming,
        3 => Kind::Accept,
        4 => Kind::Data,
        5 => Kind::WindowUpdate,
        6 => Kind::Fin,
        7 => Kind::Reset,
        8 => Kind::Ping,
        9 => Kind::Pong,
        _ => return None,
    };
    let stream_id: [u8; STREAM_ID_BYTES] = bytes[4..20].try_into().ok()?;
    let control = matches!(kind, Kind::Ping | Kind::Pong);
    if control != (stream_id == [0; STREAM_ID_BYTES]) {
        return None;
    }
    Some(Frame {
        kind,
        stream_id,
        value: u64::from_be_bytes(bytes[20..28].try_into().ok()?),
        payload: bytes[HEADER_BYTES..].to_vec(),
    })
}

/// Fabric endpoint admissions are deliberately carried in the WebSocket URL:
/// browsers cannot set an Authorization header. Accept exactly one `ticket`
/// and the one known transport capability; every other query stays fail-closed.
pub(crate) fn validate_fabric_url(value: &str) -> Result<()> {
    let url = crate::http::Url::parse(value).context("parsing the Fabric endpoint URL")?;
    if !url.username().is_empty() || url.password().is_some() || url.fragment().is_some() {
        anyhow::bail!("Fabric endpoint URLs cannot contain credentials or fragments");
    }
    let mut ticket = None;
    let mut flow = false;
    for (name, value) in url.query_pairs() {
        match name.as_ref() {
            "ticket" if ticket.is_none() && !value.is_empty() && value.len() <= 4096 => {
                ticket = Some(value.into_owned());
            }
            "flow" if !flow && value == TRANSPORT_FLOW => flow = true,
            _ => anyhow::bail!("Fabric endpoint URL has an unsupported query field"),
        }
    }
    if ticket.is_none() {
        anyhow::bail!("Fabric endpoint URL must contain exactly one bounded ticket");
    }
    let host = url
        .host_str()
        .context("the Fabric endpoint URL has no host")?
        .trim_start_matches('[')
        .trim_end_matches(']');
    let loopback = host
        .parse::<IpAddr>()
        .ok()
        .is_some_and(|address| address.is_loopback());
    match url.scheme() {
        "wss" => Ok(()),
        "ws" if loopback => Ok(()),
        "ws" => anyhow::bail!(
            "remote Fabric admissions require wss; ws is allowed only for a literal loopback IP"
        ),
        other => anyhow::bail!("unsupported Fabric endpoint URL scheme '{other}'"),
    }
}

fn transport_flow_url(value: &str) -> Result<String> {
    let mut url = crate::http::Url::parse(value).context("parsing the Fabric endpoint URL")?;
    let existing = url
        .query_pairs()
        .find(|(name, _)| name == "flow")
        .map(|(_, value)| value.into_owned());
    match existing.as_deref() {
        None => {
            url.query_pairs_mut().append_pair("flow", TRANSPORT_FLOW);
        }
        Some(TRANSPORT_FLOW) => {}
        Some(_) => anyhow::bail!("Fabric endpoint URL has an unsupported flow capability"),
    }
    validate_fabric_url(url.as_str())?;
    Ok(url.into())
}

/// One authenticated peer link to a machine that is somewhere else.
pub struct FabricLink {
    pub welcome: genehub_proto::PeerWelcome,
    pub carrier: endpoint::Carrier,
    /// Kept alongside the carrier rather than inside this struct's own `Drop`,
    /// so a caller can take the carrier and still hold the socket open.
    pub pump: FabricPump,
}

/// Keeps the socket and its two pumps alive for as long as it is held.
pub struct FabricPump(Vec<tokio::task::JoinHandle<()>>);

impl Drop for FabricPump {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

/// Why a Fabric route could not be opened.
///
/// Separated from the message because the caller has to decide whether to wait
/// and retry: a machine that is asleep and a credential that was withdrawn are
/// both "no", and treating them the same teaches people to retry forever or to
/// re-pair a machine that was only offline.
#[derive(Debug)]
pub enum DialError {
    /// Something answered, and would not carry this call.
    Refused { reason: Refusal, message: String },
    /// Nothing answered, or the answer never arrived.
    Unavailable(String),
    /// Something answered and did not speak this protocol.
    Protocol(String),
}

/// The kinds of "no" a dial can get, told apart by what to do about them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Nothing is holding the far end of that route at the moment. Nothing was
    /// spent finding out, so trying again later is free and often right.
    Offline,
    /// The far end is there and will not accept this credential. Waiting
    /// changes nothing; pairing again does.
    Credential,
    /// The relay itself cannot take another route right now.
    Busy,
    /// An answer this build does not recognise.
    Other,
}

impl std::fmt::Display for DialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DialError::Refused { message, .. }
            | DialError::Unavailable(message)
            | DialError::Protocol(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for DialError {}

/// Opens the client half of a Fabric route: the same wire the daemon serves on
/// the other side, driven from the end that placed the call.
///
/// Deliberately in this file rather than beside its caller. Both halves speak
/// one codec, and a second implementation of it somewhere else is the kind of
/// thing that agrees on the golden vector and disagrees about flow control at
/// three in the morning.
pub async fn dial(
    url: &str,
    route_ticket: &str,
    hello: &genehub_proto::PeerHello,
) -> std::result::Result<FabricLink, DialError> {
    let endpoint_url =
        transport_flow_url(url).map_err(|error| DialError::Protocol(format!("{error:#}")))?;
    let socket = tokio::time::timeout(CONNECT_TIMEOUT, ws::connect(&endpoint_url, socket_config()))
        .await
        .map_err(|_| DialError::Unavailable("the relay did not answer in time".into()))?
        .map_err(dial_error)?;
    let (mut sink, mut source) = socket.split();

    let mut stream_id = [0u8; STREAM_ID_BYTES];
    stream_id.copy_from_slice(uuid::Uuid::new_v4().as_bytes());
    // A client stream id of all zeroes is the control channel, and the codec
    // refuses it. One in 2^128 is not a risk worth a retry loop, but it is
    // worth a byte.
    if stream_id == [0; STREAM_ID_BYTES] {
        stream_id[0] = 1;
    }
    let hello_wire =
        serde_json::to_vec(hello).map_err(|error| DialError::Protocol(error.to_string()))?;
    let open = Frame {
        kind: Kind::Open,
        stream_id,
        value: INITIAL_CREDIT,
        payload: open_payload(route_ticket, &hello_wire)
            .map_err(|error| DialError::Protocol(format!("{error:#}")))?,
    };
    let wire = encode(&open).map_err(|error| DialError::Protocol(format!("{error:#}")))?;
    sink.send(Message::Binary(wire))
        .await
        .map_err(|error| DialError::Unavailable(format!("sending the peer hello: {error}")))?;

    let accept = tokio::time::timeout(CONNECT_TIMEOUT, next_frame(&mut source, stream_id))
        .await
        .map_err(|_| DialError::Unavailable("the peer handshake timed out".into()))?
        .map_err(|error| DialError::Unavailable(format!("{error:#}")))?;
    if accept.kind == Kind::Reset {
        return Err(reset_error(accept.value));
    }
    if accept.kind != Kind::Accept {
        return Err(DialError::Unavailable(
            "the route closed before it was accepted".into(),
        ));
    }
    let welcome: genehub_proto::PeerWelcome = serde_json::from_slice(&accept.payload)
        .map_err(|_| DialError::Protocol("that machine returned an invalid peer welcome".into()))?;
    let flow = StreamFlow::from_wire(accept.value)
        .map_err(|error| DialError::Protocol(format!("{error:#}")))?;

    let (messages_tx, mut messages_rx) = mpsc::channel::<Message>(WRITER_QUEUE);
    let socket_writer = tokio::spawn(async move {
        while let Some(message) = messages_rx.recv().await {
            if sink.send(message).await.is_err() {
                return;
            }
        }
    });
    let writer = Writer {
        messages: messages_tx,
    };
    let (inbound, mut outbound, carrier) = endpoint::carrier_channels();

    let reader_writer = writer.clone();
    let reader_flow = flow.clone();
    let reader = tokio::spawn(async move {
        let mut sequence = 0u64;
        while let Ok(frame) = next_frame(&mut source, stream_id).await {
            if matches!(frame.kind, Kind::Fin | Kind::Reset) {
                return;
            }
            match frame.kind {
                Kind::Data => {
                    let bytes = frame.payload.len() as u64;
                    if bytes == 0 || frame.value != sequence + 1 {
                        return;
                    }
                    sequence = frame.value;
                    if inbound.send(frame.payload).await.is_err() {
                        return;
                    }
                    // Returned only once the bounded carrier queue has taken
                    // ownership, so credit tracks what was consumed rather
                    // than what was merely read off the socket.
                    if !reader_flow.is_transport()
                        && reader_writer
                            .frame(Frame {
                                kind: Kind::WindowUpdate,
                                stream_id,
                                value: bytes,
                                payload: Vec::new(),
                            })
                            .await
                            .is_err()
                    {
                        return;
                    }
                }
                Kind::WindowUpdate => {
                    if !reader_flow.add(frame.value) {
                        return;
                    }
                }
                Kind::Ping => {
                    let _ = reader_writer
                        .frame(Frame {
                            kind: Kind::Pong,
                            ..frame
                        })
                        .await;
                }
                Kind::Pong => {}
                _ => return,
            }
        }
    });

    let sender = tokio::spawn(async move {
        let mut sequence = 0u64;
        while let Some(record) = outbound.recv().await {
            if record.is_empty() || record.len() > genehub_proto::MAX_DATA_FRAME_BYTES {
                return;
            }
            if flow.take(record.len()).await.is_err() {
                return;
            }
            sequence += 1;
            if writer
                .frame(Frame {
                    kind: Kind::Data,
                    stream_id,
                    value: sequence,
                    payload: record,
                })
                .await
                .is_err()
            {
                return;
            }
        }
    });

    Ok(FabricLink {
        welcome,
        carrier,
        pump: FabricPump(vec![socket_writer, reader, sender]),
    })
}

/// Says what a reset on a freshly opened route means.
///
/// The codes are the relay's and the machine's, and the split that matters to
/// a caller is not their numbering but whether waiting would change the
/// answer.
fn reset_error(code: u64) -> DialError {
    match code {
        5 => DialError::Refused {
            reason: Refusal::Offline,
            message: "that machine is not currently connected to its relay".into(),
        },
        10 => DialError::Refused {
            reason: Refusal::Busy,
            message: "the relay is too busy to open another route right now".into(),
        },
        // RouteDenied from the relay means the ticket names no route; from the
        // machine it means the peer handshake did not verify. Neither improves
        // by retrying.
        4 => DialError::Refused {
            reason: Refusal::Credential,
            message: "that machine would not accept this credential".into(),
        },
        8 | 9 => DialError::Refused {
            reason: Refusal::Credential,
            message: "the credential behind this route was revoked or has expired".into(),
        },
        other => DialError::Refused {
            reason: Refusal::Other,
            message: format!("the route was refused (reset {other})"),
        },
    }
}

/// Turns a failed WebSocket upgrade into something a caller can act on.
fn dial_error(error: tokio_tungstenite::tungstenite::Error) -> DialError {
    match error {
        tokio_tungstenite::tungstenite::Error::Http(response) => match response.status().as_u16() {
            // A relay refuses a client slot it has no online machine for with
            // the same answer it gives a slot that never existed. It cannot
            // tell those apart, and saying "offline" is the reading that costs
            // a caller a wait rather than an unnecessary re-pairing.
            403 => DialError::Refused {
                reason: Refusal::Offline,
                message: "the relay has no route to that machine; it may be offline".into(),
            },
            401 => DialError::Refused {
                reason: Refusal::Credential,
                message: "the relay refused the credential for that address".into(),
            },
            503 => DialError::Refused {
                reason: Refusal::Busy,
                message: "the relay is up but cannot authorize routes right now".into(),
            },
            other => DialError::Refused {
                reason: Refusal::Other,
                message: format!("the relay refused this call with status {other}"),
            },
        },
        // A URL the client cannot even turn into a request is not a relay that
        // failed to answer, and retrying it will not change the answer.
        tokio_tungstenite::tungstenite::Error::Url(error) => {
            DialError::Protocol(format!("that endpoint is not usable: {error}"))
        }
        other => DialError::Unavailable(format!("the relay could not be reached: {other}")),
    }
}

/// The OPEN body: the route ticket the relay consumes, then the peer hello it
/// must not be able to read into.
///
/// The relay strips the ticket and forwards the remainder verbatim, which is
/// why the split is by length rather than by any structure the relay could be
/// tempted to parse.
fn open_payload(route_ticket: &str, hello: &[u8]) -> Result<Vec<u8>> {
    let ticket = route_ticket.as_bytes();
    if ticket.is_empty() || ticket.len() > MAX_ROUTE_TICKET_BYTES {
        anyhow::bail!("a Fabric route ticket must be 1..{MAX_ROUTE_TICKET_BYTES} bytes");
    }
    if hello.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES {
        anyhow::bail!("the peer hello exceeds its bounded field");
    }
    let mut out = Vec::with_capacity(2 + ticket.len() + hello.len());
    out.extend_from_slice(&(ticket.len() as u16).to_be_bytes());
    out.extend_from_slice(ticket);
    out.extend_from_slice(hello);
    Ok(out)
}

/// The next frame on this route, skipping control traffic addressed elsewhere.
async fn next_frame<S>(source: &mut S, stream_id: [u8; STREAM_ID_BYTES]) -> Result<Frame>
where
    S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
{
    loop {
        let message = source
            .next()
            .await
            .ok_or_else(|| anyhow!("the Fabric route closed"))??;
        match message {
            Message::Binary(bytes) => {
                let frame = decode(&bytes).ok_or_else(|| anyhow!("malformed Fabric frame"))?;
                match frame.kind {
                    // Returned rather than raised: the reset code is the only
                    // thing that separates "that machine is asleep" from "that
                    // credential is no longer honoured", and the caller is the
                    // one that has to say which happened.
                    Kind::Fin | Kind::Reset if frame.stream_id == stream_id => return Ok(frame),
                    // Ping arrives on the control stream, so it is the one
                    // frame that legitimately does not carry this route's id.
                    Kind::Ping | Kind::Pong => return Ok(frame),
                    _ if frame.stream_id != stream_id => continue,
                    _ => return Ok(frame),
                }
            }
            Message::Ping(_) | Message::Pong(_) => continue,
            Message::Close(_) => anyhow::bail!("the Fabric route closed"),
            Message::Text(_) => anyhow::bail!("Fabric sent a text WebSocket message"),
            _ => continue,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fabric_codec_matches_the_browser_and_relay_golden_vector() {
        let mut id = [0u8; 16];
        for (index, byte) in id.iter_mut().enumerate() {
            *byte = index as u8;
        }
        let frame = Frame {
            kind: Kind::Data,
            stream_id: id,
            value: 1,
            payload: b"hi".to_vec(),
        };
        assert_eq!(
            hex(&encode(&frame).unwrap()),
            "02040000000102030405060708090a0b0c0d0e0f00000000000000016869"
        );
        let decoded = decode(&encode(&frame).unwrap()).unwrap();
        assert_eq!(decoded.kind, Kind::Data);
        assert_eq!(decoded.stream_id, id);
        assert_eq!(decoded.value, 1);
        assert_eq!(decoded.payload, b"hi");
    }

    #[test]
    fn fabric_url_accepts_only_one_ticket_on_a_safe_websocket_origin() {
        for good in [
            "wss://relay.example/fabric/v2?ticket=one-use",
            "wss://relay.example/fabric/v2?ticket=one-use&flow=transport-v1",
            "ws://127.0.0.1:8787/fabric/v2?ticket=local",
            "ws://[::1]:8787/fabric/v2?ticket=local",
        ] {
            validate_fabric_url(good).unwrap();
        }
        for bad in [
            "wss://relay.example/fabric/v2",
            "wss://relay.example/fabric/v2?ticket=",
            "wss://relay.example/fabric/v2?ticket=a&route=b",
            "wss://relay.example/fabric/v2?ticket=a&flow=unknown",
            "wss://relay.example/fabric/v2?ticket=a&flow=transport-v1&flow=transport-v1",
            "wss://user:pass@relay.example/fabric/v2?ticket=a",
            "ws://relay.example/fabric/v2?ticket=a",
            "https://relay.example/fabric/v2?ticket=a",
        ] {
            assert!(validate_fabric_url(bad).is_err(), "accepted {bad}");
        }
        assert_eq!(
            transport_flow_url("wss://relay.example/fabric/v2?ticket=one-use").unwrap(),
            "wss://relay.example/fabric/v2?ticket=one-use&flow=transport-v1"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }
}
