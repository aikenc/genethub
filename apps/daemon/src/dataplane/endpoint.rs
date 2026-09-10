use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    ErrorCode, ExchangeRequestHead, ExchangeResponseHead, ProtocolError, ProtocolIdentity, Reply,
    Request, ServerFrame, TransportKind, PROTOCOL_IDENTITY_METHOD, WEB_PROTOCOL_VERSION,
};
use tokio::sync::{broadcast, mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use super::authenticated_channel::{authenticated_channel, AuthenticatedWriter, Role};
pub use super::authenticated_channel::{carrier_channels, Carrier};
use crate::authz::{self, Capability, Principal, StreamMethod};
use crate::channel_auth::SessionKey;
use crate::dataplane::frame::{Frame, Kind, MAX_PAYLOAD_BYTES};
use crate::router::{self, SideEffect};
use crate::state::Shared;

const WRITER_COMMAND_QUEUE: usize = 1024;
const STREAM_CHUNK_QUEUE: usize = 256;
const EVENT_QUEUE: usize = 256;
const MAX_RPC_BODY_BYTES: usize = 3 * 1024 * 1024;
const MAX_SUBSCRIPTIONS: usize = 64;

pub const RESET_CANCELLED: u32 = 1;
pub const RESET_PROTOCOL: u32 = 2;
pub const RESET_REFUSED: u32 = 3;
pub const RESET_TOO_LARGE: u32 = 4;
pub const RESET_TIMEOUT: u32 = 5;
pub const RESET_ENDPOINT_CLOSED: u32 = 6;

#[derive(Clone, Copy)]
pub enum CarrierKind {
    WebSocket,
    Fabric,
    Rtc,
}

impl CarrierKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::WebSocket => "websocket",
            Self::Fabric => "fabric",
            Self::Rtc => "rtc",
        }
    }
}

#[derive(Clone)]
pub struct PeerAccess {
    /// Original authenticated authority, inherited by ephemeral RTC admissions.
    pub principal: String,
    pub(crate) direct_only: bool,
    pub(crate) authorization_expires_at: Option<std::time::Instant>,
    pub transport: TransportKind,
    pub device_id: Option<String>,
    /// A resource-routed peer may operate only this daemon-local workspace.
    pub workspace_id: Option<String>,
    /// The locator visible to the browser. Hosted routes use a Hub workspace
    /// handle while local routes use the daemon-local id.
    pub workspace_handle: Option<String>,
    pub bootstrap_invite: Option<String>,
}

struct IncomingChunk {
    bytes: Vec<u8>,
    _permit: OwnedSemaphorePermit,
    _lease: Option<super::logical_connection::Lease>,
}

enum Incoming {
    Chunk(IncomingChunk),
    Fin,
    Reset(u32),
}

struct StreamState {
    handler: Option<tokio::task::AbortHandle>,
    inbound: mpsc::Sender<Incoming>,
    inbound_budget: Arc<Semaphore>,
    remote_sequence: u32,
    remote_bytes: u64,
    expected_remote_bytes: Option<u64>,
    remote_finished: bool,
    outbound_credit: Credit,
}

#[derive(Clone)]
struct Credit {
    inner: Arc<CreditInner>,
}

struct CreditInner {
    value: Mutex<u32>,
    maximum: u32,
    notify: tokio::sync::Notify,
}

impl Credit {
    fn new(value: u32) -> Result<Self> {
        if value == 0 || value > genehub_proto::MAX_BULK_STREAM_WINDOW_BYTES {
            anyhow::bail!("invalid initial stream credit");
        }
        Ok(Self {
            inner: Arc::new(CreditInner {
                value: Mutex::new(value),
                maximum: value,
                notify: tokio::sync::Notify::new(),
            }),
        })
    }

    async fn take(&self, maximum: usize) -> Result<usize> {
        loop {
            let notified = self.inner.notify.notified();
            {
                let mut value = self.inner.value.lock().unwrap();
                if *value > 0 {
                    let taken = maximum.min(*value as usize).min(MAX_PAYLOAD_BYTES);
                    *value -= taken as u32;
                    return Ok(taken);
                }
            }
            notified.await;
        }
    }

    fn add(&self, value: u32) -> bool {
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

struct WriterCommand {
    stream_id: u32,
    frame: Frame,
    complete: oneshot::Sender<Result<()>>,
    _budget: OwnedSemaphorePermit,
    _count: OwnedSemaphorePermit,
}

#[derive(Clone)]
struct Writer {
    commands: mpsc::Sender<WriterCommand>,
    budget: Arc<Semaphore>,
    progress: Arc<Semaphore>,
    count: Arc<Semaphore>,
}

impl Writer {
    async fn send(&self, frame: Frame) -> Result<()> {
        let stream_id = frame.stream_id;
        let (complete, answer) = oneshot::channel();
        let budget = if frame.kind as u8 >= 4 {
            &self.progress
        } else {
            &self.budget
        };
        let budget = budget
            .clone()
            .acquire_many_owned((frame.payload.len() + 36) as u32)
            .await?;
        let count = self.count.clone().acquire_owned().await?;
        self.commands
            .send(WriterCommand {
                stream_id,
                frame,
                complete,
                _budget: budget,
                _count: count,
            })
            .await
            .map_err(|_| anyhow!("the data-plane writer stopped"))?;
        answer
            .await
            .map_err(|_| anyhow!("the data-plane writer dropped a frame"))??;
        Ok(())
    }

    fn try_send(&self, frame: Frame) -> Result<()> {
        let stream_id = frame.stream_id;
        let (complete, _answer) = oneshot::channel();
        let budget = if frame.kind as u8 >= 4 {
            &self.progress
        } else {
            &self.budget
        };
        let budget = budget
            .clone()
            .try_acquire_many_owned((frame.payload.len() + 36) as u32)?;
        let count = self.count.clone().try_acquire_owned()?;
        self.commands
            .try_send(WriterCommand {
                stream_id,
                frame,
                complete,
                _budget: budget,
                _count: count,
            })
            .map_err(|_| anyhow!("the data-plane writer queue is full"))
    }
}

enum EndpointCommand {
    Retire(u32),
}

pub(crate) struct ServerStream {
    id: u32,
    pub(crate) head: ExchangeRequestHead,
    inbound: mpsc::Receiver<Incoming>,
    writer: Writer,
    commands: mpsc::Sender<EndpointCommand>,
    credit: Credit,
    local_sequence: u32,
    local_bytes: u64,
    expected_local_bytes: Option<u64>,
    response_status: Option<u16>,
    diagnostic_operation: Option<String>,
    local_head_sent: bool,
    local_finished: bool,
}

pub(crate) enum StreamInput {
    Chunk(Vec<u8>),
    Fin,
    Reset(u32),
}

impl ServerStream {
    /// Reads one request-side chunk and returns its stream credit immediately
    /// after ownership has moved into the business handler. Duplex handlers
    /// use this instead of waiting for a finite request body.
    pub(crate) async fn next_input(&mut self) -> Result<StreamInput> {
        match self.inbound.recv().await {
            Some(Incoming::Chunk(chunk)) => {
                let IncomingChunk {
                    bytes,
                    _permit,
                    _lease,
                } = chunk;
                drop(_lease);
                let credit = bytes.len() as u32;
                drop(_permit);
                self.writer
                    .send(Frame {
                        kind: Kind::WindowUpdate,
                        stream_id: self.id,
                        value: credit,
                        payload: Vec::new(),
                    })
                    .await?;
                Ok(StreamInput::Chunk(bytes))
            }
            Some(Incoming::Fin) => Ok(StreamInput::Fin),
            Some(Incoming::Reset(code)) => Ok(StreamInput::Reset(code)),
            None => anyhow::bail!("peer stream ended before request FIN"),
        }
    }

    pub(crate) async fn read_body(&mut self, maximum: usize) -> Result<Vec<u8>> {
        let mut body = Vec::new();
        loop {
            match self.next_input().await? {
                StreamInput::Chunk(bytes) => {
                    let next = body
                        .len()
                        .checked_add(bytes.len())
                        .ok_or_else(|| anyhow!("request body length overflow"))?;
                    if next > maximum {
                        self.reset(RESET_TOO_LARGE).await;
                        anyhow::bail!("request body is too large");
                    }
                    body.extend_from_slice(&bytes);
                }
                StreamInput::Fin => {
                    if self
                        .head
                        .body_length
                        .is_some_and(|expected| expected != body.len() as u64)
                    {
                        self.reset(RESET_PROTOCOL).await;
                        anyhow::bail!("request body length does not match its head");
                    }
                    return Ok(body);
                }
                StreamInput::Reset(code) => anyhow::bail!("peer reset stream ({code})"),
            }
        }
    }

    pub(crate) async fn respond(&mut self, head: &ExchangeResponseHead) -> Result<()> {
        if self.local_head_sent || self.local_finished {
            anyhow::bail!("response head was already sent");
        }
        if !(100..=599).contains(&head.status)
            || head
                .body_length
                .is_some_and(|length| length > genehub_proto::MAX_FINITE_EXCHANGE_BODY_BYTES as u64)
        {
            anyhow::bail!("response head contains an invalid finite body");
        }
        let payload = serde_json::to_vec(head)?;
        if payload.is_empty() || payload.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES {
            anyhow::bail!("response head exceeds its bounded wire field");
        }
        self.writer
            .send(Frame {
                kind: Kind::Head,
                stream_id: self.id,
                value: genehub_proto::INITIAL_STREAM_WINDOW_BYTES,
                payload,
            })
            .await?;
        self.expected_local_bytes = head.body_length;
        self.response_status = Some(head.status);
        self.local_head_sent = true;
        Ok(())
    }

    pub(crate) async fn write(&mut self, bytes: &[u8]) -> Result<()> {
        if !self.local_head_sent || self.local_finished {
            anyhow::bail!("response body cannot be written in this stream state");
        }
        let mut offset = 0;
        while offset < bytes.len() {
            let length = self.credit.take(bytes.len() - offset).await?;
            let next = self
                .local_bytes
                .checked_add(length as u64)
                .ok_or_else(|| anyhow!("response body length overflow"))?;
            if self
                .expected_local_bytes
                .is_some_and(|expected| next > expected)
            {
                anyhow::bail!("response body exceeds the length in its head");
            }
            self.local_sequence = self
                .local_sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("stream sequence exhausted"))?;
            self.writer
                .send(Frame {
                    kind: Kind::Data,
                    stream_id: self.id,
                    value: self.local_sequence,
                    payload: bytes[offset..offset + length].to_vec(),
                })
                .await?;
            self.local_bytes = next;
            offset += length;
        }
        Ok(())
    }

    pub(super) async fn write_message<T: serde::Serialize>(&mut self, message: &T) -> Result<()> {
        let body = serde_json::to_vec(message)?;
        let length = u32::try_from(body.len()).context("event message is too large")?;
        let mut wire = Vec::with_capacity(4 + body.len());
        wire.extend_from_slice(&length.to_be_bytes());
        wire.extend_from_slice(&body);
        self.write(&wire).await
    }

    pub(crate) async fn finish(&mut self) -> Result<()> {
        if self.local_finished {
            return Ok(());
        }
        if !self.local_head_sent {
            anyhow::bail!("response stream cannot finish before its head");
        }
        if self
            .expected_local_bytes
            .is_some_and(|expected| expected != self.local_bytes)
        {
            anyhow::bail!("response body length does not match its head");
        }
        self.local_finished = true;
        self.writer
            .send(Frame {
                kind: Kind::Fin,
                stream_id: self.id,
                value: 0,
                payload: Vec::new(),
            })
            .await?;
        let _ = self.commands.send(EndpointCommand::Retire(self.id)).await;
        Ok(())
    }

    async fn reset(&mut self, code: u32) {
        if self.local_finished {
            return;
        }
        self.local_finished = true;
        let _ = self
            .writer
            .send(Frame {
                kind: Kind::Reset,
                stream_id: self.id,
                value: code,
                payload: Vec::new(),
            })
            .await;
        let _ = self.commands.send(EndpointCommand::Retire(self.id)).await;
    }
}

#[derive(Default)]
struct SubscriptionTasks {
    stopped: bool,
    tasks: HashMap<String, tokio::task::JoinHandle<()>>,
}

pub(crate) struct PeerServices {
    pub(crate) state: Shared,
    pub(crate) access: PeerAccess,
    event_sender: mpsc::Sender<ServerFrame>,
    event_receiver: tokio::sync::Mutex<Option<mpsc::Receiver<ServerFrame>>>,
    subscriptions: Mutex<SubscriptionTasks>,
    pub(crate) carrier_kind: CarrierKind,
}

/// Logical peer state has one lifetime owner, independent of record crypto.
/// The registry retains this owner across detach and destroys it at logical
/// termination; invitation bootstrap deliberately retains physical lifetime.
struct PeerRuntime {
    streams: HashMap<u32, StreamState>,
    handlers: JoinSet<()>,
    services: Arc<PeerServices>,
    writer_task: tokio::task::JoinHandle<()>,
    fanout_task: Option<tokio::task::JoinHandle<()>>,
}

impl Drop for PeerRuntime {
    fn drop(&mut self) {
        // This also runs when the serve future is cancelled (e.g. RTC teardown),
        // not just on the normal/error return paths below. No await in teardown.
        self.handlers.abort_all();
        let mut subscriptions = self
            .services
            .subscriptions
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // abort() does not preempt a handler currently being polled elsewhere.
        // Fence its final registration under this same lock before draining.
        subscriptions.stopped = true;
        for (_, task) in subscriptions.tasks.drain() {
            task.abort();
        }
        drop(subscriptions);
        if let Some(task) = &self.fanout_task {
            task.abort();
        }
        self.writer_task.abort();
        if let Some(device_id) = &self.services.access.device_id {
            self.services.state.devices.mark_disconnected(device_id);
        }
    }
}

/// Serves one already mutually-authenticated peer until its carrier closes.
pub(crate) enum PeerReader {
    Physical(super::authenticated_channel::AuthenticatedReader),
    Logical(super::logical_connection::Reader),
}
impl PeerReader {
    pub(crate) async fn receive(
        &mut self,
    ) -> Result<Option<(Frame, Option<super::logical_connection::Lease>)>> {
        match self {
            Self::Physical(reader) => reader
                .receive()
                .await?
                .map(|bytes| Frame::decode(&bytes).map(|frame| (frame, None)))
                .transpose(),
            Self::Logical(reader) => Ok(reader
                .receive()
                .await
                .map(|received| (received.frame, Some(received.lease)))),
        }
    }
}
pub(crate) enum PeerWriter {
    Physical(AuthenticatedWriter),
    Logical(super::logical_connection::Writer),
}
impl PeerWriter {
    pub(crate) async fn send(&mut self, frame: Frame) -> Result<()> {
        match self {
            Self::Physical(writer) => writer.send(&frame.encode()?).await,
            Self::Logical(writer) => writer.send(frame).await,
        }
    }
}

pub async fn serve(
    state: Shared,
    key: SessionKey,
    access: PeerAccess,
    carrier: Carrier,
    carrier_kind: CarrierKind,
) -> Result<()> {
    // Bootstrap is intentionally non-resumable and retains the same stream
    // engine with physical lifetime; it cannot create registry credentials.
    if access.bootstrap_invite.is_some() {
        let (reader, writer) = authenticated_channel(key, carrier, Role::Server);
        return serve_streams(
            state,
            access,
            PeerReader::Physical(reader),
            PeerWriter::Physical(writer),
            carrier_kind,
        )
        .await;
    }
    super::logical_connection::serve(state, key, access, carrier, carrier_kind).await
}
pub(crate) async fn serve_logical(
    state: Shared,
    access: PeerAccess,
    reader: super::logical_connection::Reader,
    writer: super::logical_connection::Writer,
    carrier_kind: CarrierKind,
) -> Result<()> {
    serve_streams(
        state,
        access,
        PeerReader::Logical(reader),
        PeerWriter::Logical(writer),
        carrier_kind,
    )
    .await
}
async fn serve_streams(
    state: Shared,
    access: PeerAccess,
    mut channel_reader: PeerReader,
    channel_writer: PeerWriter,
    carrier_kind: CarrierKind,
) -> Result<()> {
    let mut revocations = state.devices.subscribe_revocations();
    if access
        .device_id
        .as_ref()
        .is_some_and(|id| state.devices.grants(id).is_none())
    {
        anyhow::bail!("the peer device was revoked");
    }
    let (writer_tx, writer_rx) = mpsc::channel(WRITER_COMMAND_QUEUE);
    let writer = Writer {
        commands: writer_tx,
        budget: Arc::new(Semaphore::new(4 * 1024 * 1024)),
        progress: Arc::new(Semaphore::new(64 * 1024)),
        count: Arc::new(Semaphore::new(256)),
    };
    let (writer_failed_tx, mut writer_failed) = oneshot::channel();
    let writer_task = tokio::spawn(run_writer(channel_writer, writer_rx, writer_failed_tx));
    let (commands_tx, mut commands) = mpsc::channel::<EndpointCommand>(WRITER_COMMAND_QUEUE);
    let (event_sender, event_receiver) = mpsc::channel(EVENT_QUEUE);
    let services = Arc::new(PeerServices {
        state: state.clone(),
        access: access.clone(),
        event_sender,
        event_receiver: tokio::sync::Mutex::new(Some(event_receiver)),
        subscriptions: Mutex::new(SubscriptionTasks::default()),
        carrier_kind,
    });

    // A terminal is shared across a user's own devices on purpose, but this
    // fanout reaches every authenticated peer, and a device that was never
    // granted `pty` must not be sent the terminal anyway. Gating only
    // `pty.open` would leave the output arriving unasked, which is the half
    // that matters: a shell shows keystrokes, paths, and whatever the user
    // pastes into it.
    //
    // Decided once, at connection: grants are fixed when a device is paired,
    // and revoking one drops its connections rather than editing them.
    let watcher = Principal::of(&state, &access);
    let scoped_processes = access.workspace_id.is_some();
    state
        .diagnostics
        .record("stream", "data.endpoint", "online", None);
    let fanout_task = state.fanout.get().map(|fanout| {
        let mut receiver = fanout.subscribe();
        let events = services.event_sender.clone();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(frame) => {
                        if frame_requires(&frame)
                            .is_some_and(|capability| !watcher.allows(capability))
                        {
                            continue;
                        }
                        let frame = if scoped_processes
                            && matches!(frame, ServerFrame::BackgroundProcesses { .. })
                        {
                            // A notification only; the client refetches its scoped snapshot.
                            ServerFrame::BackgroundProcesses {
                                processes: Vec::new(),
                            }
                        } else {
                            frame
                        };
                        if events.send(frame).await.is_err() {
                            return;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                    Err(broadcast::error::RecvError::Lagged(_)) => return,
                }
            }
        })
    });

    if let Some(device_id) = &access.device_id {
        state.devices.mark_connected(device_id);
    }
    let mut peer = PeerRuntime {
        streams: HashMap::new(),
        handlers: JoinSet::new(),
        services,
        writer_task,
        fanout_task,
    };

    let outcome = async {
        loop {
            tokio::select! {
                plaintext = channel_reader.receive() => {
                    let Some((frame, lease)) = plaintext? else { break Ok(()); };
                    dispatch(
                        frame,
                        lease,
                        &mut peer.streams,
                        &writer,
                        &commands_tx,
                        &peer.services,
                        &mut peer.handlers,
                    )?;
                }
                _ = peer.handlers.join_next(), if !peer.handlers.is_empty() => {}
                _ = async { peer.fanout_task.as_mut().unwrap().await }, if peer.fanout_task.is_some() => {
                    break Err(anyhow!("event fanout closed or lost its delivery position"));
                }
                command = commands.recv() => {
                    match command {
                        Some(EndpointCommand::Retire(stream_id)) => { peer.streams.remove(&stream_id); }
                        None => break Ok(()),
                    }
                }
                failed = &mut writer_failed => {
                    break Err(failed.unwrap_or_else(|_| anyhow!("data-plane writer stopped")));
                }
                revoked = revocations.recv(), if access.device_id.is_some() => {
                    match revoked {
                        Ok(id) if access.device_id.as_ref() == Some(&id) => {
                            state.logical_connections.revoke_device(&id);
                            break Err(anyhow!("the peer device was revoked"));
                        }
                        Ok(_) => {}
                        Err(_) => break Err(anyhow!("device revocation state was lost")),
                    }
                }
            }
        }
    }
    .await;

    peer.handlers.abort_all();
    while peer.handlers.join_next().await.is_some() {}
    drop(peer);
    state.diagnostics.record(
        "stream",
        "data.endpoint",
        if outcome.is_ok() { "offline" } else { "error" },
        if outcome.is_ok() {
            None
        } else {
            Some("carrier")
        },
    );
    outcome
}

fn dispatch(
    frame: Frame,
    lease: Option<super::logical_connection::Lease>,
    streams: &mut HashMap<u32, StreamState>,
    writer: &Writer,
    commands: &mpsc::Sender<EndpointCommand>,
    services: &Arc<PeerServices>,
    handlers: &mut JoinSet<()>,
) -> Result<()> {
    if matches!(frame.kind, Kind::Ping) {
        if frame.stream_id != 0 || !frame.payload.is_empty() {
            anyhow::bail!("malformed data-plane ping");
        }
        writer.try_send(Frame {
            kind: Kind::Pong,
            ..frame
        })?;
        return Ok(());
    }
    if matches!(frame.kind, Kind::Pong) {
        return Ok(());
    }

    if matches!(frame.kind, Kind::Open) {
        if frame.stream_id == 0
            || frame.stream_id.is_multiple_of(2)
            || streams.contains_key(&frame.stream_id)
            || streams.len() >= genehub_proto::MAX_ACTIVE_DATA_STREAMS
            || frame.payload.is_empty()
            || frame.payload.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES
        {
            writer.try_send(Frame {
                kind: Kind::Reset,
                stream_id: frame.stream_id,
                value: RESET_REFUSED,
                payload: Vec::new(),
            })?;
            return Ok(());
        }
        let head: ExchangeRequestHead =
            serde_json::from_slice(&frame.payload).context("invalid exchange request head")?;
        if head.version != genehub_proto::DATA_PLANE_VERSION
            || head.method.is_empty()
            || head.method.len() > 128
            || head
                .body_length
                .is_some_and(|length| length > MAX_RPC_BODY_BYTES as u64)
            || head
                .timeout_ms
                .is_some_and(|timeout| timeout == 0 || timeout > 3_600_000)
        {
            writer.try_send(Frame {
                kind: Kind::Reset,
                stream_id: frame.stream_id,
                value: RESET_PROTOCOL,
                payload: Vec::new(),
            })?;
            return Ok(());
        }
        let maximum_window = genehub_proto::INITIAL_STREAM_WINDOW_BYTES;
        if frame.value == 0 || frame.value > maximum_window {
            writer.try_send(Frame {
                kind: Kind::Reset,
                stream_id: frame.stream_id,
                value: RESET_PROTOCOL,
                payload: Vec::new(),
            })?;
            return Ok(());
        }
        let (inbound, receiver) = mpsc::channel(STREAM_CHUNK_QUEUE);
        let inbound_budget = Arc::new(Semaphore::new(
            genehub_proto::INITIAL_STREAM_WINDOW_BYTES as usize,
        ));
        let credit = Credit::new(frame.value)?;
        streams.insert(
            frame.stream_id,
            StreamState {
                handler: None,
                inbound,
                inbound_budget,
                remote_sequence: 0,
                remote_bytes: 0,
                expected_remote_bytes: head.body_length,
                remote_finished: false,
                outbound_credit: credit.clone(),
            },
        );
        let stream = ServerStream {
            id: frame.stream_id,
            head,
            inbound: receiver,
            writer: writer.clone(),
            commands: commands.clone(),
            credit,
            local_sequence: 0,
            local_bytes: 0,
            expected_local_bytes: None,
            response_status: None,
            diagnostic_operation: None,
            local_head_sent: false,
            local_finished: false,
        };
        let services = services.clone();
        let handler = handlers.spawn(async move {
            if let Err(error) = handle_stream(stream, services).await {
                tracing::debug!(%error, "data-plane stream ended");
            }
        });
        streams.get_mut(&frame.stream_id).unwrap().handler = Some(handler);
        return Ok(());
    }

    let Some(stream) = streams.get_mut(&frame.stream_id) else {
        if !matches!(frame.kind, Kind::Reset) {
            writer.try_send(Frame {
                kind: Kind::Reset,
                stream_id: frame.stream_id,
                value: RESET_PROTOCOL,
                payload: Vec::new(),
            })?;
        }
        return Ok(());
    };
    match frame.kind {
        Kind::Data => {
            let expected = stream
                .remote_sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("stream sequence exhausted"))?;
            if stream.remote_finished || frame.value != expected || frame.payload.is_empty() {
                anyhow::bail!("invalid stream data sequence");
            }
            let next_bytes = stream
                .remote_bytes
                .checked_add(frame.payload.len() as u64)
                .ok_or_else(|| anyhow!("request body length overflow"))?;
            if stream
                .expected_remote_bytes
                .is_some_and(|expected| next_bytes > expected)
            {
                anyhow::bail!("request body exceeds the length in its head");
            }
            let bytes = u32::try_from(frame.payload.len())?;
            let permit = stream
                .inbound_budget
                .clone()
                .try_acquire_many_owned(bytes)
                .map_err(|_| anyhow!("peer exceeded its stream receive window"))?;
            stream
                .inbound
                .try_send(Incoming::Chunk(IncomingChunk {
                    bytes: frame.payload,
                    _permit: permit,
                    _lease: lease,
                }))
                .map_err(|_| anyhow!("stream handler receive queue is full"))?;
            stream.remote_sequence = expected;
            stream.remote_bytes = next_bytes;
        }
        Kind::WindowUpdate => {
            if !frame.payload.is_empty() || !stream.outbound_credit.add(frame.value) {
                anyhow::bail!("invalid stream window update");
            }
        }
        Kind::Fin => {
            if stream.remote_finished
                || frame.value != 0
                || !frame.payload.is_empty()
                || stream
                    .expected_remote_bytes
                    .is_some_and(|expected| expected != stream.remote_bytes)
            {
                anyhow::bail!("malformed stream FIN");
            }
            stream
                .inbound
                .try_send(Incoming::Fin)
                .map_err(|_| anyhow!("stream handler receive queue is full"))?;
            stream.remote_finished = true;
        }
        Kind::Reset => {
            if frame.value == 0 || !frame.payload.is_empty() {
                anyhow::bail!("malformed stream RESET");
            }
            if let Some(handler) = &stream.handler {
                handler.abort();
            }
            let _ = stream.inbound.try_send(Incoming::Reset(frame.value));
            streams.remove(&frame.stream_id);
        }
        Kind::Head | Kind::Open | Kind::Ping | Kind::Pong => {
            anyhow::bail!("invalid client-to-daemon stream transition")
        }
    }
    Ok(())
}

async fn handle_stream(mut stream: ServerStream, services: Arc<PeerServices>) -> Result<()> {
    let started = Instant::now();
    let request_id = diagnostic_id(&stream.head.metadata);
    let exchange_method = stream.head.method.clone();
    let request_bytes = stream.head.body_length;
    let result = if let Some(timeout_ms) = stream.head.timeout_ms {
        match tokio::time::timeout_at(
            tokio::time::Instant::from_std(started)
                + std::time::Duration::from_millis(timeout_ms as u64),
            serve_stream(&mut stream, &services),
        )
        .await
        {
            Ok(result) => result,
            Err(_) => {
                stream.reset(RESET_TIMEOUT).await;
                Err(anyhow!("stream deadline expired"))
            }
        }
    } else {
        serve_stream(&mut stream, &services).await
    };
    if result.is_err() {
        stream.reset(RESET_PROTOCOL).await;
    }
    if exchange_method != "events" {
        let operation = stream
            .diagnostic_operation
            .clone()
            .unwrap_or_else(|| exchange_method.clone());
        let status = stream.response_status;
        let outcome = if result.is_ok() && status.is_some_and(|value| value < 400) {
            "ok"
        } else {
            "error"
        };
        let duration_ms = started.elapsed().as_millis().min(u64::MAX as u128) as u64;
        if let Some(operation) = support_stream_operation(&exchange_method) {
            services.state.diagnostics.record(
                "stream",
                operation,
                outcome,
                support_status_code(status, result.is_err()),
            );
        }
        if outcome == "error" {
            tracing::warn!(
                target: "diagnostic",
                operation,
                request_id,
                transport = services.carrier_kind.as_str(),
                status,
                duration_ms,
                request_bytes,
                response_bytes = stream.local_bytes,
                "data operation failed"
            );
        } else if exchange_method == "asset.preview" || exchange_method == "rtc.negotiate" {
            tracing::info!(
                target: "diagnostic",
                operation,
                request_id,
                transport = services.carrier_kind.as_str(),
                status,
                duration_ms,
                request_bytes,
                response_bytes = stream.local_bytes,
                "data operation completed"
            );
        }
    }
    result
}

async fn serve_stream(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if stream.head.method == "rpc" {
        // Per-request rather than per-stream: one RPC stream carries one
        // operation, and they do not all cost the same.
        return handle_rpc(stream, services).await;
    }
    if stream.head.method == PROTOCOL_IDENTITY_METHOD {
        return handle_protocol_identity(stream, services).await;
    }
    let Some(method) = StreamMethod::parse(&stream.head.method) else {
        return send_error(stream, 404, ErrorCode::NotFound, "unknown exchange method").await;
    };
    let needed = method.required();
    if !Principal::of(&services.state, &services.access).allows(needed) {
        services.state.diagnostics.record(
            "stream",
            "authorization",
            "error",
            Some(needed.as_str()),
        );
        return refuse(stream, needed).await;
    }
    match method {
        StreamMethod::Events => handle_events(stream, services).await,
        StreamMethod::ProtocolIdentity => handle_protocol_identity(stream, services).await,
        StreamMethod::AssetPreview => crate::dataplane::preview::handle(stream, services).await,
        StreamMethod::ServicePreview => {
            crate::dataplane::service_preview::handle(stream, services).await
        }
        StreamMethod::ShellRun => crate::dataplane::exec::handle(stream, services).await,
        StreamMethod::RtcNegotiate => crate::dataplane::rtc::handle(stream, services).await,
        StreamMethod::RtcConfig => crate::dataplane::rtc::config_handle(stream, services).await,
        StreamMethod::SpeechTranscribe => crate::speech::handle(stream, services).await,
    }
}

/// What a peer must have been granted to be told this.
///
/// Matched by name with no wildcard so that a new frame has to be classified
/// here before it can be broadcast. Anything unsaid would be broadcast to
/// every authenticated peer, which is the wrong default for a push: the peer
/// never asked, so it never had a request for the usual check to refuse.
fn frame_requires(frame: &ServerFrame) -> Option<Capability> {
    match frame {
        ServerFrame::PtyOutput { .. } | ServerFrame::PtyClosed { .. } => Some(Capability::Pty),
        // Command lines of what an agent ran. The same material as the tool
        // calls in a timeline, and gated the same way.
        ServerFrame::BackgroundProcesses { .. } => Some(Capability::Session),
        ServerFrame::Event { .. }
        | ServerFrame::Desync { .. }
        | ServerFrame::Notice { .. }
        | ServerFrame::UpdateDownloadChanged { .. } => None,
    }
}

/// The one wording for "you are authenticated, and this is still not yours".
///
/// It names the missing capability rather than the request, so that a caller
/// that was narrowed on purpose can tell that apart from a request it got
/// wrong, and ask for the right invitation instead of retrying.
async fn refuse(stream: &mut ServerStream, needed: Capability) -> Result<()> {
    send_error(
        stream,
        403,
        ErrorCode::Forbidden,
        format!(
            "this device was not granted `{}` on this machine",
            needed.as_str()
        ),
    )
    .await
}

async fn handle_protocol_identity(
    stream: &mut ServerStream,
    services: &PeerServices,
) -> Result<()> {
    let needed = StreamMethod::ProtocolIdentity.required();
    if !Principal::of(&services.state, &services.access).allows(needed) {
        services.state.diagnostics.record(
            "stream",
            "authorization",
            "error",
            Some(needed.as_str()),
        );
        return refuse(stream, needed).await;
    }
    let body = stream.read_body(0).await?;
    if !body.is_empty() {
        anyhow::bail!("protocol.identity has no request body");
    }
    let payload = serde_json::to_vec(&ProtocolIdentity {
        web_protocol: WEB_PROTOCOL_VERSION,
    })?;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::Value::Null,
            body_length: Some(payload.len() as u64),
            error: None,
        })
        .await?;
    stream.write(&payload).await?;
    stream.finish().await
}

async fn handle_rpc(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let body = stream.read_body(MAX_RPC_BODY_BYTES).await?;
    let request: Request = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(error) => {
            return send_error(
                stream,
                400,
                ErrorCode::BadRequest,
                format!("invalid RPC operation body: {error}"),
            )
            .await;
        }
    };
    stream.diagnostic_operation = diagnostic_operation(&stream.head.metadata);
    if let Some(scope) = &services.access.workspace_id {
        if matches!(request, Request::ClientDebug(_)) {
            return send_error(
                stream,
                403,
                ErrorCode::Forbidden,
                "client debugging requires a machine capability, not a workspace capability",
            )
            .await;
        }
        if matches!(request, Request::ProcessList) {
            return send_error(
                stream,
                403,
                ErrorCode::Forbidden,
                "use workspace-scoped process listing",
            )
            .await;
        }
        if let Request::ProcessKill { session_id, .. } | Request::ProcessKillAll { session_id } =
            &request
        {
            let allowed = services
                .state
                .sessions
                .list(Some(scope), true)
                .await?
                .iter()
                .any(|session| &session.id == session_id);
            if !allowed {
                return send_error(
                    stream,
                    403,
                    ErrorCode::Forbidden,
                    "session outside workspace capability",
                )
                .await;
            }
        }
        if let Some(requested) = request_workspace(&request) {
            if requested != scope {
                return send_error(
                    stream,
                    403,
                    ErrorCode::Forbidden,
                    "the routed capability does not cover this workspace",
                )
                .await;
            }
        }
    }

    if let (
        Some(invite_id),
        Request::DeviceClaim {
            code, device_name, ..
        },
    ) = (services.access.bootstrap_invite.as_deref(), &request)
    {
        if code != invite_id {
            return send_error(
                stream,
                401,
                ErrorCode::Unauthorized,
                "pairing invitation does not match this peer session",
            )
            .await;
        }
        let reply = match services
            .state
            .devices
            .claim_authenticated(invite_id, device_name)
        {
            Ok((mut credential, _)) => {
                credential.machine_name = crate::link::default_display_name();
                credential.machine_id = services.state.machine.machine_id.clone();
                credential.fingerprint = services.state.machine.fingerprint();
                Reply::Claimed(credential)
            }
            Err(error) => {
                return send_error(stream, 401, ErrorCode::Unauthorized, format!("{error:#}")).await
            }
        };
        return send_reply(stream, reply).await;
    }
    if services.access.bootstrap_invite.is_some() {
        return send_error(
            stream,
            401,
            ErrorCode::Unauthorized,
            "pairing sessions may only redeem their invitation",
        )
        .await;
    }

    // Resolved once and carried into the router: a request that decides what
    // to enforce on a spawned process must be looking at the same caller the
    // gate just admitted, not at a second lookup that could disagree with it.
    let caller = Principal::of(&services.state, &services.access);
    let needed = authz::required(&request);
    if !caller.allows(needed) {
        services
            .state
            .diagnostics
            .record("rpc", "authorization", "error", Some(needed.as_str()));
        return refuse(stream, needed).await;
    }

    let handled =
        router::handle(&services.state, services.access.transport, &caller, request).await;
    match handled.reply {
        Ok(reply) => {
            send_reply(stream, reply).await?;
            apply_side_effect(services, handled.effect).await;
            Ok(())
        }
        Err(error) => send_protocol_error(stream, error).await,
    }
}

fn diagnostic_id(metadata: &serde_json::Value) -> Option<String> {
    metadata
        .get("diagnosticId")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 96
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
        .map(str::to_string)
}

fn diagnostic_operation(metadata: &serde_json::Value) -> Option<String> {
    metadata
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
        })
        .map(str::to_string)
}

fn support_stream_operation(method: &str) -> Option<&'static str> {
    match method {
        "asset.preview" => Some("asset.preview"),
        "service.preview" => Some("service.preview"),
        "rtc.negotiate" => Some("rtc.negotiate"),
        "shell.run" => Some("shell.run"),
        _ => None,
    }
}

fn support_status_code(status: Option<u16>, transport_error: bool) -> Option<&'static str> {
    if transport_error {
        Some("transport")
    } else {
        match status {
            Some(400..=499) => Some("clientError"),
            Some(500..=599) => Some("serverError"),
            _ => None,
        }
    }
}

async fn send_reply(stream: &mut ServerStream, reply: Reply) -> Result<()> {
    let body = serde_json::to_vec(&reply)?;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::Value::Null,
            body_length: Some(body.len() as u64),
            error: None,
        })
        .await?;
    stream.write(&body).await?;
    stream.finish().await
}

async fn send_protocol_error(stream: &mut ServerStream, error: ProtocolError) -> Result<()> {
    let status = match error.code {
        ErrorCode::BadRequest => 400,
        ErrorCode::Unauthorized => 401,
        ErrorCode::Forbidden => 403,
        ErrorCode::NotFound => 404,
        ErrorCode::Conflict => 409,
        ErrorCode::Unsupported => 422,
        ErrorCode::WebProtocol => 426,
        ErrorCode::Internal => 500,
        // Not 403: the caller is allowed, the machine is unable. Retrying with
        // a wider grant would not help, and neither would retrying at all
        // until this machine gains a backend.
        ErrorCode::IsolationUnavailable => 501,
    };
    stream
        .respond(&ExchangeResponseHead {
            status,
            metadata: serde_json::Value::Null,
            body_length: Some(0),
            error: Some(error),
        })
        .await?;
    stream.finish().await
}

pub(crate) async fn send_error(
    stream: &mut ServerStream,
    status: u16,
    code: ErrorCode,
    message: impl Into<String>,
) -> Result<()> {
    stream
        .respond(&ExchangeResponseHead {
            status,
            metadata: serde_json::Value::Null,
            body_length: Some(0),
            error: Some(ProtocolError {
                code,
                message: message.into(),
            }),
        })
        .await?;
    stream.finish().await
}

async fn apply_side_effect(services: &PeerServices, effect: SideEffect) {
    let mut subscriptions = services.subscriptions.lock().unwrap();
    if subscriptions.stopped {
        return;
    }
    match effect {
        SideEffect::None => {}
        SideEffect::Unsubscribe { session_id } => {
            if let Some(task) = subscriptions.tasks.remove(&session_id) {
                task.abort();
            }
        }
        SideEffect::Subscribe {
            session_id,
            mut receiver,
        } => {
            if !subscriptions.tasks.contains_key(&session_id)
                && subscriptions.tasks.len() >= MAX_SUBSCRIPTIONS
            {
                return;
            }
            if let Some(previous) = subscriptions.tasks.remove(&session_id) {
                previous.abort();
            }
            let events = services.event_sender.clone();
            let topic = session_id.clone();
            let task = tokio::spawn(async move {
                loop {
                    let frame = match receiver.recv().await {
                        Ok(event) => ServerFrame::event(&topic, event),
                        Err(broadcast::error::RecvError::Lagged(missed)) => ServerFrame::Desync {
                            session_id: topic.clone(),
                            missed,
                        },
                        Err(broadcast::error::RecvError::Closed) => return,
                    };
                    if events.send(frame).await.is_err() {
                        return;
                    }
                }
            });
            subscriptions.tasks.insert(session_id, task);
        }
    }
}

async fn handle_events(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let body = stream.read_body(0).await?;
    if !body.is_empty() {
        anyhow::bail!("events stream has no request body");
    }
    let Some(mut receiver) = services.event_receiver.lock().await.take() else {
        return send_error(
            stream,
            409,
            ErrorCode::Conflict,
            "this peer already has an events stream",
        )
        .await;
    };
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::json!({ "codec": "json-u32be" }),
            body_length: None,
            error: None,
        })
        .await?;
    while let Some(frame) = receiver.recv().await {
        stream.write_message(&frame).await?;
    }
    stream.finish().await
}

fn request_workspace(request: &Request) -> Option<&str> {
    match request {
        Request::SessionFork {
            target: Some(target),
            ..
        }
        | Request::SessionForkImport { target, .. } => target.workspace_id.as_deref(),
        Request::ProcessWorkspaceList { workspace_id }
        | Request::ProcessServiceStop { workspace_id, .. }
        | Request::SessionCreate { workspace_id, .. }
        | Request::SessionImportList { workspace_id, .. }
        | Request::SessionImport { workspace_id, .. }
        | Request::FileTree { workspace_id, .. }
        | Request::FileWrite { workspace_id, .. }
        | Request::FileMkdir { workspace_id, .. }
        | Request::FileCopy { workspace_id, .. }
        | Request::FileMove { workspace_id, .. }
        | Request::FileDelete { workspace_id, .. }
        | Request::GitStatus { workspace_id }
        | Request::GitDiff { workspace_id, .. }
        | Request::GitCommit { workspace_id, .. }
        | Request::PtyOpen { workspace_id, .. }
        | Request::SpeechContextPreview { workspace_id, .. }
        | Request::SpeechFeedbackRecord { workspace_id, .. }
        | Request::WorkspaceRename { workspace_id, .. }
        | Request::WorkspaceRemove { workspace_id } => Some(workspace_id),
        _ => None,
    }
}

async fn run_writer(
    mut channel: PeerWriter,
    mut commands: mpsc::Receiver<WriterCommand>,
    failed: oneshot::Sender<anyhow::Error>,
) {
    if let PeerWriter::Logical(writer) = channel {
        run_logical_writer(writer, commands, failed).await;
        return;
    }
    let mut queues = HashMap::<u32, VecDeque<WriterCommand>>::new();
    let mut runnable = VecDeque::<u32>::new();
    let outcome: Result<()> = async {
        loop {
            if runnable.is_empty() {
                let Some(command) = commands.recv().await else {
                    return Ok(());
                };
                enqueue_writer(command, &mut queues, &mut runnable);
            }
            while let Ok(command) = commands.try_recv() {
                enqueue_writer(command, &mut queues, &mut runnable);
            }
            let Some(stream_id) = runnable.pop_front() else {
                continue;
            };
            let Some(queue) = queues.get_mut(&stream_id) else {
                continue;
            };
            let Some(command) = queue.pop_front() else {
                queues.remove(&stream_id);
                continue;
            };
            if !queue.is_empty() {
                runnable.push_back(stream_id);
            } else {
                queues.remove(&stream_id);
            }
            match channel.send(command.frame).await {
                Ok(()) => {
                    let _ = command.complete.send(Ok(()));
                }
                Err(_) => {
                    let error = anyhow!("the peer carrier writer stopped");
                    let _ = command.complete.send(Err(anyhow!(error.to_string())));
                    return Err(error);
                }
            }
        }
    }
    .await;
    let error = outcome
        .err()
        .unwrap_or_else(|| anyhow!("data-plane writer stopped"));
    for (_, queue) in queues {
        for command in queue {
            let _ = command.complete.send(Err(anyhow!(error.to_string())));
        }
    }
    let _ = failed.send(error);
}

async fn run_logical_writer(
    writer: super::logical_connection::Writer,
    mut commands: mpsc::Receiver<WriterCommand>,
    failed: oneshot::Sender<anyhow::Error>,
) {
    let mut active = std::collections::HashSet::new();
    let mut queues = HashMap::<u32, VecDeque<WriterCommand>>::new();
    let mut tasks = JoinSet::new();
    let outcome: Result<()> = async {
        loop {
            tokio::select! {
                command = commands.recv() => {
                    let Some(command) = command else { return Ok(()); };
                    queues.entry(command.stream_id).or_default().push_back(command);
                }
                done = tasks.join_next(), if !tasks.is_empty() => {
                    let (id, result) = done.ok_or_else(|| anyhow!("logical writer stopped"))??;
                    active.remove(&id);
                    result?;
                }
            }
            let runnable: Vec<_> = queues
                .keys()
                .filter(|id| !active.contains(*id))
                .copied()
                .collect();
            for id in runnable {
                let queue = queues.get_mut(&id).unwrap();
                let Some(command) = queue.pop_front() else {
                    continue;
                };
                if queue.is_empty() {
                    queues.remove(&id);
                }
                active.insert(id);
                let mut writer = writer.clone();
                tasks.spawn(async move {
                    let result = writer.send(command.frame).await;
                    let report = result
                        .as_ref()
                        .map(|_| ())
                        .map_err(|e| anyhow!(e.to_string()));
                    let _ = command.complete.send(report);
                    drop(command._budget);
                    drop(command._count);
                    (id, result)
                });
            }
        }
    }
    .await;
    let _ = failed.send(
        outcome
            .err()
            .unwrap_or_else(|| anyhow!("logical writer stopped")),
    );
}

fn enqueue_writer(
    command: WriterCommand,
    queues: &mut HashMap<u32, VecDeque<WriterCommand>>,
    runnable: &mut VecDeque<u32>,
) {
    let queue = queues.entry(command.stream_id).or_default();
    if queue.is_empty() {
        runnable.push_back(command.stream_id);
    }
    queue.push_back(command);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn credit_never_exceeds_its_negotiated_stream_window() {
        let credit = Credit::new(10).unwrap();
        assert_eq!(credit.take(7).await.unwrap(), 7);
        assert!(credit.add(7));
        assert!(!credit.add(1));
        let bulk = Credit::new(genehub_proto::MAX_BULK_STREAM_WINDOW_BYTES).unwrap();
        assert_eq!(bulk.take(1).await.unwrap(), 1);
        assert!(bulk.add(1));
    }

    #[test]
    fn writer_queue_rotates_streams_without_business_priorities() {
        let command = |stream_id| WriterCommand {
            stream_id,
            frame: Frame {
                kind: Kind::Data,
                stream_id,
                value: 1,
                payload: vec![1],
            },
            complete: oneshot::channel().0,
            _budget: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
            _count: Arc::new(Semaphore::new(1)).try_acquire_owned().unwrap(),
        };
        let mut queues = HashMap::new();
        let mut runnable = VecDeque::new();
        enqueue_writer(command(1), &mut queues, &mut runnable);
        enqueue_writer(command(3), &mut queues, &mut runnable);
        enqueue_writer(command(1), &mut queues, &mut runnable);
        assert_eq!(runnable, VecDeque::from([1, 3]));
    }

    #[test]
    fn diagnostic_metadata_accepts_only_bounded_opaque_labels() {
        assert_eq!(
            diagnostic_operation(&serde_json::json!({ "operation": "file.tree" })).as_deref(),
            Some("file.tree")
        );
        assert_eq!(
            diagnostic_operation(&serde_json::json!({ "operation": "settings/get?token=x" })),
            None
        );
    }

    #[test]
    fn directed_forks_are_scoped_to_the_destination_workspace() {
        let target = genehub_proto::ForkTarget {
            agent_id: "codex".into(),
            workspace_id: Some("target-workspace".into()),
            model_id: None,
            mode_id: None,
            effort_id: None,
        };
        assert_eq!(
            request_workspace(&Request::SessionFork {
                session_id: "source".into(),
                turn_id: "turn".into(),
                target: Some(target.clone()),
            }),
            Some("target-workspace")
        );
        assert_eq!(
            request_workspace(&Request::SessionForkImport {
                transfer: genehub_proto::ForkTransfer {
                    source_session_id: "source".into(),
                    source_turn_id: "turn".into(),
                    source_agent_id: "codex".into(),
                    source_round_id: None,
                    title: None,
                    items: Vec::new(),
                    coverage: genehub_proto::HistoryCoverage {
                        source_item_count: Some(0),
                        retained_item_count: 0,
                        omitted_item_count: 0,
                        retrieval: genehub_proto::RetrievalCapability::Genehub,
                        reason: None,
                    },
                    blob_appendix: vec![],
                },
                target,
            }),
            Some("target-workspace")
        );
    }
}
