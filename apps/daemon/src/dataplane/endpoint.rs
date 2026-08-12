use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    ErrorCode, ExchangeRequestHead, ExchangeResponseHead, ProtocolError, Reply, Request,
    ServerFrame, TransportKind,
};
use tokio::sync::{broadcast, mpsc, oneshot, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinSet;

use crate::authz::{self, Capability, Principal, StreamMethod};
use crate::channel_auth::{self, Direction, SessionKey};
use crate::dataplane::frame::{Frame, Kind, MAX_PAYLOAD_BYTES};
use crate::router::{self, SideEffect};
use crate::state::Shared;

// At the largest legal record this queue is exactly one 256 KiB stream
// window. Carrier readers therefore cannot acknowledge unbounded bytes merely
// by moving them out of a socket callback while a business handler is slow.
const CARRIER_QUEUE: usize = 16;
const WRITER_COMMAND_QUEUE: usize = 1024;
const STREAM_CHUNK_QUEUE: usize = 32;
const EVENT_QUEUE: usize = 256;
const MAX_RPC_BODY_BYTES: usize = 3 * 1024 * 1024;
const MAX_SUBSCRIPTIONS: usize = 64;

pub const RESET_CANCELLED: u32 = 1;
pub const RESET_PROTOCOL: u32 = 2;
pub const RESET_REFUSED: u32 = 3;
pub const RESET_TOO_LARGE: u32 = 4;
pub const RESET_TIMEOUT: u32 = 5;
pub const RESET_ENDPOINT_CLOSED: u32 = 6;

/// Message-preserving records supplied by local WebSocket, Relay Fabric, or
/// WebRTC.  No business handler receives these channels directly.
pub struct Carrier {
    pub inbound: mpsc::Receiver<Vec<u8>>,
    pub outbound: mpsc::Sender<Vec<u8>>,
}

pub fn carrier_channels() -> (mpsc::Sender<Vec<u8>>, mpsc::Receiver<Vec<u8>>, Carrier) {
    let (inbound_tx, inbound) = mpsc::channel(CARRIER_QUEUE);
    let (outbound, outbound_rx) = mpsc::channel(CARRIER_QUEUE);
    (inbound_tx, outbound_rx, Carrier { inbound, outbound })
}

#[derive(Clone)]
pub struct PeerAccess {
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
}

enum Incoming {
    Chunk(IncomingChunk),
    Fin,
    Reset(u32),
}

struct StreamState {
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
    notify: tokio::sync::Notify,
}

impl Credit {
    fn new(value: u32) -> Result<Self> {
        if value == 0 || value > genehub_proto::INITIAL_STREAM_WINDOW_BYTES {
            anyhow::bail!("invalid initial stream credit");
        }
        Ok(Self {
            inner: Arc::new(CreditInner {
                value: Mutex::new(value),
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
        if next > genehub_proto::INITIAL_STREAM_WINDOW_BYTES {
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
}

#[derive(Clone)]
struct Writer {
    commands: mpsc::Sender<WriterCommand>,
}

impl Writer {
    async fn send(&self, frame: Frame) -> Result<()> {
        let stream_id = frame.stream_id;
        let (complete, answer) = oneshot::channel();
        self.commands
            .send(WriterCommand {
                stream_id,
                frame,
                complete,
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
        self.commands
            .try_send(WriterCommand {
                stream_id,
                frame,
                complete,
            })
            .map_err(|_| anyhow!("the data-plane writer queue is full"))
    }
}

enum EndpointCommand {
    Retire(u32),
}

pub(super) struct ServerStream {
    id: u32,
    pub(super) head: ExchangeRequestHead,
    inbound: mpsc::Receiver<Incoming>,
    writer: Writer,
    commands: mpsc::Sender<EndpointCommand>,
    credit: Credit,
    local_sequence: u32,
    local_bytes: u64,
    expected_local_bytes: Option<u64>,
    local_head_sent: bool,
    local_finished: bool,
}

impl ServerStream {
    pub(super) async fn read_body(&mut self, maximum: usize) -> Result<Vec<u8>> {
        let mut body = Vec::new();
        while let Some(incoming) = self.inbound.recv().await {
            match incoming {
                Incoming::Chunk(chunk) => {
                    let next = body
                        .len()
                        .checked_add(chunk.bytes.len())
                        .ok_or_else(|| anyhow!("request body length overflow"))?;
                    if next > maximum {
                        self.reset(RESET_TOO_LARGE).await;
                        anyhow::bail!("request body is too large");
                    }
                    body.extend_from_slice(&chunk.bytes);
                    let credit = chunk.bytes.len() as u32;
                    drop(chunk);
                    self.writer
                        .send(Frame {
                            kind: Kind::WindowUpdate,
                            stream_id: self.id,
                            value: credit,
                            payload: Vec::new(),
                        })
                        .await?;
                }
                Incoming::Fin => {
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
                Incoming::Reset(code) => anyhow::bail!("peer reset stream ({code})"),
            }
        }
        anyhow::bail!("peer stream ended before request FIN")
    }

    pub(super) async fn respond(&mut self, head: &ExchangeResponseHead) -> Result<()> {
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
        self.local_head_sent = true;
        Ok(())
    }

    pub(super) async fn write(&mut self, bytes: &[u8]) -> Result<()> {
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

    async fn write_message<T: serde::Serialize>(&mut self, message: &T) -> Result<()> {
        let body = serde_json::to_vec(message)?;
        let length = u32::try_from(body.len()).context("event message is too large")?;
        let mut wire = Vec::with_capacity(4 + body.len());
        wire.extend_from_slice(&length.to_be_bytes());
        wire.extend_from_slice(&body);
        self.write(&wire).await
    }

    pub(super) async fn finish(&mut self) -> Result<()> {
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

pub(super) struct PeerServices {
    pub(super) state: Shared,
    pub(super) access: PeerAccess,
    event_sender: mpsc::Sender<ServerFrame>,
    event_receiver: tokio::sync::Mutex<Option<mpsc::Receiver<ServerFrame>>>,
    subscriptions: tokio::sync::Mutex<HashMap<String, tokio::task::JoinHandle<()>>>,
}

/// Serves one already mutually-authenticated peer until its carrier closes.
pub async fn serve(
    state: Shared,
    key: SessionKey,
    access: PeerAccess,
    mut carrier: Carrier,
) -> Result<()> {
    let (writer_tx, writer_rx) = mpsc::channel(WRITER_COMMAND_QUEUE);
    let writer = Writer {
        commands: writer_tx,
    };
    let (writer_failed_tx, mut writer_failed) = oneshot::channel();
    let writer_task = tokio::spawn(run_writer(
        key.clone(),
        carrier.outbound.clone(),
        writer_rx,
        writer_failed_tx,
    ));
    let (commands_tx, mut commands) = mpsc::channel::<EndpointCommand>(WRITER_COMMAND_QUEUE);
    let (event_sender, event_receiver) = mpsc::channel(EVENT_QUEUE);
    let services = Arc::new(PeerServices {
        state: state.clone(),
        access: access.clone(),
        event_sender,
        event_receiver: tokio::sync::Mutex::new(Some(event_receiver)),
        subscriptions: tokio::sync::Mutex::new(HashMap::new()),
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
    let watches_terminals = Principal::of(&state, &access).allows(Capability::Pty);
    let fanout_task = state.fanout.get().map(|fanout| {
        let mut receiver = fanout.subscribe();
        let events = services.event_sender.clone();
        tokio::spawn(async move {
            loop {
                match receiver.recv().await {
                    Ok(frame) => {
                        if !watches_terminals && terminal_frame(&frame) {
                            continue;
                        }
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

    let mut revocations = state.devices.subscribe_revocations();
    if let Some(device_id) = &access.device_id {
        state.devices.mark_connected(device_id);
    }
    let mut streams = HashMap::<u32, StreamState>::new();
    let mut handlers = JoinSet::new();
    let mut receive_sequence = 0u64;

    let outcome = loop {
        tokio::select! {
            record = carrier.inbound.recv() => {
                let Some(record) = record else { break Ok(()); };
                receive_sequence = receive_sequence.checked_add(1)
                    .ok_or_else(|| anyhow!("data record sequence exhausted"))?;
                let plaintext = channel_auth::open_data_record(
                    &key,
                    Direction::ClientToDaemon,
                    receive_sequence,
                    &record,
                )?;
                let frame = Frame::decode(&plaintext)?;
                dispatch(
                    frame,
                    &mut streams,
                    &writer,
                    &commands_tx,
                    &services,
                    &mut handlers,
                )?;
            }
            command = commands.recv() => {
                match command {
                    Some(EndpointCommand::Retire(stream_id)) => { streams.remove(&stream_id); }
                    None => break Ok(()),
                }
            }
            failed = &mut writer_failed => {
                break Err(failed.unwrap_or_else(|_| anyhow!("data-plane writer stopped")));
            }
            revoked = revocations.recv(), if access.device_id.is_some() => {
                match revoked {
                    Ok(id) if access.device_id.as_ref() == Some(&id) => {
                        break Err(anyhow!("the peer device was revoked"));
                    }
                    Ok(_) => {}
                    Err(_) => break Err(anyhow!("device revocation state was lost")),
                }
            }
        }
    };

    handlers.abort_all();
    while handlers.join_next().await.is_some() {}
    for (_, task) in services.subscriptions.lock().await.drain() {
        task.abort();
    }
    if let Some(task) = fanout_task {
        task.abort();
    }
    writer_task.abort();
    if let Some(device_id) = &access.device_id {
        state.devices.mark_disconnected(device_id);
    }
    outcome
}

fn dispatch(
    frame: Frame,
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
            || frame.value == 0
            || frame.value > genehub_proto::INITIAL_STREAM_WINDOW_BYTES
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
        let (inbound, receiver) = mpsc::channel(STREAM_CHUNK_QUEUE);
        let inbound_budget = Arc::new(Semaphore::new(
            genehub_proto::INITIAL_STREAM_WINDOW_BYTES as usize,
        ));
        let credit = Credit::new(frame.value)?;
        streams.insert(
            frame.stream_id,
            StreamState {
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
            local_head_sent: false,
            local_finished: false,
        };
        let services = services.clone();
        handlers.spawn(async move {
            if let Err(error) = handle_stream(stream, services).await {
                tracing::debug!(%error, "data-plane stream ended");
            }
        });
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
    let result = serve_stream(&mut stream, &services).await;
    if result.is_err() {
        stream.reset(RESET_PROTOCOL).await;
    }
    result
}

async fn serve_stream(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    if stream.head.method == "rpc" {
        // Per-request rather than per-stream: one RPC stream carries one
        // operation, and they do not all cost the same.
        return handle_rpc(stream, services).await;
    }
    let Some(method) = StreamMethod::parse(&stream.head.method) else {
        return send_error(stream, 404, ErrorCode::NotFound, "unknown exchange method").await;
    };
    let needed = method.required();
    if !Principal::of(&services.state, &services.access).allows(needed) {
        return refuse(stream, needed).await;
    }
    match method {
        StreamMethod::Events => handle_events(stream, services).await,
        StreamMethod::AssetPreview => crate::dataplane::preview::handle(stream, services).await,
        StreamMethod::RtcNegotiate => crate::dataplane::rtc::handle(stream, services).await,
    }
}

/// Whether a frame carries terminal traffic.
///
/// Matched by name with no wildcard so that a new terminal-bearing frame has
/// to be classified here before it can be broadcast to peers that were never
/// granted a terminal.
fn terminal_frame(frame: &ServerFrame) -> bool {
    match frame {
        ServerFrame::PtyOutput { .. } | ServerFrame::PtyClosed { .. } => true,
        ServerFrame::Event { .. }
        | ServerFrame::Desync { .. }
        | ServerFrame::Notice { .. }
        | ServerFrame::UpdateDownloadChanged { .. } => false,
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

async fn handle_rpc(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let body = stream.read_body(MAX_RPC_BODY_BYTES).await?;
    let request: Request = serde_json::from_slice(&body).context("invalid RPC operation body")?;
    if let Some(scope) = &services.access.workspace_id {
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

    let needed = authz::required(&request);
    if !Principal::of(&services.state, &services.access).allows(needed) {
        return refuse(stream, needed).await;
    }

    let handled = router::handle(&services.state, services.access.transport, request).await;
    match handled.reply {
        Ok(reply) => {
            send_reply(stream, reply).await?;
            apply_side_effect(services, handled.effect).await;
            Ok(())
        }
        Err(error) => send_protocol_error(stream, error).await,
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
        ErrorCode::ProtocolVersion => 426,
        ErrorCode::Internal => 500,
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

pub(super) async fn send_error(
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
    match effect {
        SideEffect::None => {}
        SideEffect::Unsubscribe { session_id } => {
            if let Some(task) = services.subscriptions.lock().await.remove(&session_id) {
                task.abort();
            }
        }
        SideEffect::Subscribe {
            session_id,
            mut receiver,
        } => {
            let mut subscriptions = services.subscriptions.lock().await;
            if !subscriptions.contains_key(&session_id) && subscriptions.len() >= MAX_SUBSCRIPTIONS
            {
                return;
            }
            if let Some(previous) = subscriptions.remove(&session_id) {
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
            subscriptions.insert(session_id, task);
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
        Request::SessionCreate { workspace_id, .. }
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
        | Request::WorkspaceRename { workspace_id, .. }
        | Request::WorkspaceRemove { workspace_id } => Some(workspace_id),
        _ => None,
    }
}

async fn run_writer(
    key: SessionKey,
    outbound: mpsc::Sender<Vec<u8>>,
    mut commands: mpsc::Receiver<WriterCommand>,
    failed: oneshot::Sender<anyhow::Error>,
) {
    let mut queues = HashMap::<u32, VecDeque<WriterCommand>>::new();
    let mut runnable = VecDeque::<u32>::new();
    let mut sequence = 0u64;
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
            sequence = sequence
                .checked_add(1)
                .ok_or_else(|| anyhow!("data record sequence exhausted"))?;
            let plaintext = command.frame.encode()?;
            let record = channel_auth::seal_data_record(
                &key,
                Direction::DaemonToClient,
                sequence,
                &plaintext,
            )?;
            match outbound.send(record).await {
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
    async fn credit_never_exceeds_the_fixed_stream_window() {
        let credit = Credit::new(10).unwrap();
        assert_eq!(credit.take(7).await.unwrap(), 7);
        assert!(credit.add(7));
        assert!(!credit.add(genehub_proto::INITIAL_STREAM_WINDOW_BYTES));
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
        };
        let mut queues = HashMap::new();
        let mut runnable = VecDeque::new();
        enqueue_writer(command(1), &mut queues, &mut runnable);
        enqueue_writer(command(3), &mut queues, &mut runnable);
        enqueue_writer(command(1), &mut queues, &mut runnable);
        assert_eq!(runnable, VecDeque::from([1, 3]));
    }
}
