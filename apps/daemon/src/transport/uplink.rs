//! The outbound connection to the Hub's forwarding layer.
//!
//! A machine at home has no public address, so it dials out and keeps one
//! socket open. Several clients may be attached at once, so that socket is
//! multiplexed: a one-byte kind and a sixteen-byte channel id in front of every
//! payload (`docs/architecture.md` §6.4). Each channel becomes an ordinary
//! client connection as far as the rest of the daemon is concerned.

use std::collections::HashMap;
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{ServerFrame, TransportKind};
use tokio::sync::{broadcast, mpsc, Mutex, Semaphore};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Message;

use super::session;
use crate::state::Shared;

pub const KIND_OPEN: u8 = 1;
pub const KIND_TEXT: u8 = 2;
pub const KIND_BINARY: u8 = 3;
pub const KIND_CLOSE: u8 = 4;

const CHANNEL_ID_BYTES: usize = 16;
const HEADER_BYTES: usize = 1 + CHANNEL_ID_BYTES;
const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;
const MAX_CHANNELS: usize = 32;
const MAX_BUFFERED_INBOUND_BYTES: usize = 16 * 1024 * 1024;
const MAX_PENDING_CHANNEL_ADMISSIONS: usize = 8;
const MAX_CHANNEL_ADMISSIONS_PER_MINUTE: usize = 64;
const MAX_PENDING_FIRST_FRAME_BYTES: usize = 16 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(20);
const READ_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy)]
struct UplinkPolicy {
    connect_timeout: Duration,
    heartbeat_interval: Duration,
    read_idle_timeout: Duration,
    write_timeout: Duration,
}

const DEFAULT_POLICY: UplinkPolicy = UplinkPolicy {
    connect_timeout: CONNECT_TIMEOUT,
    heartbeat_interval: HEARTBEAT_INTERVAL,
    read_idle_timeout: READ_IDLE_TIMEOUT,
    write_timeout: WRITE_TIMEOUT,
};

/// Backoff between reconnection attempts, in seconds.
const BACKOFF: [u64; 6] = [1, 2, 5, 10, 30, 60];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UplinkExit {
    Reconnect,
    AdmissionRejected,
    Revoked,
}

type TicketFuture = Pin<Box<dyn Future<Output = Result<Option<String>>> + Send>>;
type TicketProvider = Arc<dyn Fn() -> TicketFuture + Send + Sync>;
type ChannelAdmissionFuture =
    Pin<Box<dyn Future<Output = Result<Option<HostedChannelAdmission>>> + Send>>;
type ChannelAdmissionProvider = Arc<dyn Fn(String) -> ChannelAdmissionFuture + Send + Sync>;
pub(crate) type ChannelLeaseFuture = Pin<Box<dyn Future<Output = Result<Option<Instant>>> + Send>>;
pub type ChannelLeaseProvider = Arc<dyn Fn(String) -> ChannelLeaseFuture + Send + Sync>;

/// A Control-redeemed secret and the daemon-enforced end of its authority.
///
/// Deliberately no `Debug`: this crosses only the daemon/Control boundary and
/// must never be rendered into logs that Relay operators could obtain.
pub struct HostedChannelAdmission {
    pub secret: String,
    pub lease_id: String,
    pub expires_at: Instant,
}

enum TicketSource {
    Static(String),
    Fresh(TicketProvider),
}

impl TicketSource {
    async fn next(&self) -> Result<Option<String>> {
        match self {
            TicketSource::Static(ticket) => Ok(Some(ticket.clone())),
            TicketSource::Fresh(provider) => provider().await,
        }
    }

    fn refreshes(&self) -> bool {
        matches!(self, TicketSource::Fresh(_))
    }
}

/// What a client arriving on this connection has to show.
///
/// The distinction is per-connection rather than per-machine on purpose: a
/// machine can be enrolled with a Hub and waiting at a rendezvous relay at the
/// same time, and the two paths must not lend each other trust.
// Deliberately no `Debug`: the hosted variant carries an E2E channel secret.
#[derive(Clone)]
pub enum Admission {
    /// Someone with the authority to say so already vouched for this client.
    Vouched,
    /// A one-use loopback upgrade authenticated the client, and this
    /// domain-separated proof lets the client authenticate the listener back.
    /// It is delivered in Hello, never in the WebSocket URL.
    Loopback { server_proof: String },
    /// Nobody vouched. The client must present a credential this machine
    /// issued, and this machine proves itself back.
    DeviceRequired,
    /// Control vouched for the route, while end-to-end authority comes from a
    /// separate per-channel secret that Relay never receives.
    Hosted {
        capability_id: String,
        secret: String,
        lease_id: String,
        expires_at: Instant,
        renew: ChannelLeaseProvider,
    },
}

pub struct Uplink {
    task: tokio::task::JoinHandle<()>,
    /// Read by `hub.status`, so the UI can distinguish "paired but the Hub is
    /// unreachable" from "not paired" — very different things to a user
    /// wondering why their phone cannot see this machine.
    online: Arc<AtomicBool>,
}

impl Uplink {
    /// Starts the reconnect loop. Returns immediately; the machine works fine
    /// without the Hub, so a failure to connect is not a failure to start.
    pub fn start(
        state: Shared,
        pty: broadcast::Sender<ServerFrame>,
        url: String,
        ticket: String,
        admission: Admission,
    ) -> Uplink {
        Self::start_with_source(
            state,
            pty,
            url,
            TicketSource::Static(ticket),
            admission,
            None,
            None,
        )
    }

    /// Starts a managed-Hub uplink whose one-use ticket is fetched immediately
    /// before every WebSocket attempt. `Ok(None)` means Control rejected the
    /// reusable enrollment credential and stops the loop; an error is retried
    /// without ever falling back to that credential at Relay.
    pub fn start_refreshing<F, Fut>(
        state: Shared,
        pty: broadcast::Sender<ServerFrame>,
        url: String,
        provider: F,
        admission: Admission,
    ) -> Uplink
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<String>>> + Send + 'static,
    {
        let provider: TicketProvider = Arc::new(move || Box::pin(provider()));
        Self::start_with_source(
            state,
            pty,
            url,
            TicketSource::Fresh(provider),
            admission,
            None,
            None,
        )
    }

    /// Starts a managed Hub uplink where every OPEN must independently redeem
    /// an E2E channel secret at Control. Relay sees only the capability name.
    pub fn start_refreshing_hosted<F, Fut, C, CFut, R, RFut>(
        state: Shared,
        pty: broadcast::Sender<ServerFrame>,
        url: String,
        ticket_provider: F,
        channel_provider: C,
        lease_provider: R,
    ) -> Uplink
    where
        F: Fn() -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Option<String>>> + Send + 'static,
        C: Fn(String) -> CFut + Send + Sync + 'static,
        CFut: Future<Output = Result<Option<HostedChannelAdmission>>> + Send + 'static,
        R: Fn(String) -> RFut + Send + Sync + 'static,
        RFut: Future<Output = Result<Option<Instant>>> + Send + 'static,
    {
        let tickets: TicketProvider = Arc::new(move || Box::pin(ticket_provider()));
        let channels: ChannelAdmissionProvider =
            Arc::new(move |capability| Box::pin(channel_provider(capability)));
        let leases: ChannelLeaseProvider =
            Arc::new(move |lease_id| Box::pin(lease_provider(lease_id)));
        Self::start_with_source(
            state,
            pty,
            url,
            TicketSource::Fresh(tickets),
            Admission::Vouched,
            Some(channels),
            Some(leases),
        )
    }

    fn start_with_source(
        state: Shared,
        pty: broadcast::Sender<ServerFrame>,
        url: String,
        tickets: TicketSource,
        admission: Admission,
        channel_provider: Option<ChannelAdmissionProvider>,
        lease_provider: Option<ChannelLeaseProvider>,
    ) -> Uplink {
        let online = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let online = online.clone();
            async move {
                let mut attempt = 0usize;
                loop {
                    let ticket = match tickets.next().await {
                        Ok(Some(ticket)) => ticket,
                        Ok(None) => {
                            online.store(false, Ordering::Relaxed);
                            tracing::error!(
                                "the Hub rejected this machine's enrollment credential; re-pairing is required"
                            );
                            break;
                        }
                        Err(error) => {
                            online.store(false, Ordering::Relaxed);
                            tracing::warn!("could not refresh the uplink admission: {error:#}");
                            attempt = (attempt + 1).min(BACKOFF.len() - 1);
                            tokio::time::sleep(jittered_backoff(BACKOFF[attempt])).await;
                            continue;
                        }
                    };
                    match run(
                        &state,
                        &pty,
                        &url,
                        &ticket,
                        &online,
                        admission.clone(),
                        channel_provider.clone(),
                        lease_provider.clone(),
                    )
                    .await
                    {
                        Ok(UplinkExit::Reconnect) => {
                            tracing::info!("the uplink closed cleanly; reconnecting");
                            attempt = 0;
                        }
                        Ok(UplinkExit::AdmissionRejected) if tickets.refreshes() => {
                            tracing::warn!(
                                "the one-use uplink admission was rejected; requesting a fresh one"
                            );
                            attempt = (attempt + 1).min(BACKOFF.len() - 1);
                        }
                        Ok(UplinkExit::AdmissionRejected) => {
                            online.store(false, Ordering::Relaxed);
                            tracing::error!(
                                "the relay rejected this uplink credential; configuration is required"
                            );
                            break;
                        }
                        Ok(UplinkExit::Revoked) => {
                            online.store(false, Ordering::Relaxed);
                            tracing::error!(
                                "the Hub revoked this machine's uplink; re-pairing is required"
                            );
                            break;
                        }
                        Err(error) => {
                            tracing::warn!("the uplink dropped: {error:#}");
                            attempt = (attempt + 1).min(BACKOFF.len() - 1);
                        }
                    }
                    online.store(false, Ordering::Relaxed);
                    tokio::time::sleep(jittered_backoff(BACKOFF[attempt])).await;
                }
            }
        });
        Uplink { task, online }
    }

    pub fn is_online(&self) -> bool {
        self.online.load(Ordering::Relaxed)
    }

    pub fn stop(&self) {
        self.task.abort();
        self.online.store(false, Ordering::Relaxed);
    }
}

/// One connection's lifetime.
// These parameters are the explicit security boundaries of one multiplexed
// uplink. Keeping them named at the call site is safer than a broad refactor of
// this transport solely to satisfy the argument-count style lint.
#[allow(clippy::too_many_arguments)]
async fn run(
    state: &Shared,
    pty: &broadcast::Sender<ServerFrame>,
    url: &str,
    ticket: &str,
    online: &AtomicBool,
    admission: Admission,
    channel_provider: Option<ChannelAdmissionProvider>,
    lease_provider: Option<ChannelLeaseProvider>,
) -> Result<UplinkExit> {
    run_with_policy(
        state,
        pty,
        url,
        ticket,
        online,
        admission,
        channel_provider,
        lease_provider,
        DEFAULT_POLICY,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn run_with_policy(
    state: &Shared,
    pty: &broadcast::Sender<ServerFrame>,
    url: &str,
    ticket: &str,
    online: &AtomicBool,
    admission: Admission,
    channel_provider: Option<ChannelAdmissionProvider>,
    lease_provider: Option<ChannelLeaseProvider>,
    policy: UplinkPolicy,
) -> Result<UplinkExit> {
    validate_uplink_url(url)?;
    let mut request = url
        .into_client_request()
        .context("building the uplink request")?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {ticket}")
            .parse()
            .context("building the uplink credential")?,
    );

    let websocket = WebSocketConfig {
        max_write_buffer_size: 8 * 1024 * 1024,
        max_message_size: Some(MAX_MESSAGE_BYTES),
        max_frame_size: Some(MAX_MESSAGE_BYTES),
        ..WebSocketConfig::default()
    };
    let connected = tokio::time::timeout(
        policy.connect_timeout,
        tokio_tungstenite::connect_async_with_config(request, Some(websocket), false),
    )
    .await
    .context("the Hub WebSocket handshake timed out")?;
    let (socket, _response) = match connected {
        Ok(connected) => connected,
        Err(tokio_tungstenite::tungstenite::Error::Http(response))
            if matches!(response.status().as_u16(), 401 | 403) =>
        {
            return Ok(UplinkExit::AdmissionRejected);
        }
        Err(error) => return Err(error).context("connecting to the Hub"),
    };
    online.store(true, Ordering::Relaxed);
    tracing::info!("uplink established");

    let (sink, mut stream) = socket.split();
    let sink = Arc::new(Mutex::new(sink));
    let mut heartbeat = tokio::time::interval(policy.heartbeat_interval);
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    heartbeat.tick().await;
    let mut last_message = Instant::now();

    // Every channel's outbound frames funnel through one sender so the socket
    // has a single writer.
    let mut channels: HashMap<String, Channel> = HashMap::new();
    let inbound_budget = Arc::new(Semaphore::new(MAX_BUFFERED_INBOUND_BYTES));
    let outbound_budget = Arc::new(Semaphore::new(session::MAX_BUFFERED_OUTBOUND_BYTES));
    let mut pending_channels: HashMap<String, PendingChannel> = HashMap::new();
    let (admitted_tx, mut admitted_rx) =
        mpsc::channel::<(String, u64, String, Result<Option<HostedChannelAdmission>>)>(
            MAX_PENDING_CHANNEL_ADMISSIONS,
        );
    let (closed_tx, mut closed_rx) = mpsc::channel::<(String, u64)>(MAX_CHANNELS);
    let mut next_generation = 0u64;
    let mut admission_window = Instant::now();
    let mut admission_attempts = 0usize;

    let mut exit = UplinkExit::Reconnect;
    loop {
        let message = tokio::select! {
            message = stream.next() => message,
            admitted = admitted_rx.recv(), if !pending_channels.is_empty() => {
                let Some((channel, generation, capability, result)) = admitted else { continue };
                let Some(mut pending) = take_matching_pending(
                    &mut pending_channels,
                    &channel,
                    generation,
                    &capability,
                ) else { continue };
                match result {
                    Ok(Some(admission)) if admission.expires_at > Instant::now() => {
                        let Some(renew) = lease_provider.clone() else {
                            send_channel_close(
                                &sink,
                                &channel,
                                b"channel lease unavailable",
                                policy.write_timeout,
                            )
                            .await?;
                            continue;
                        };
                        let opened = open_channel(
                            state,
                            pty,
                            sink.clone(),
                            channel.clone(),
                            Admission::Hosted {
                                capability_id: capability,
                                secret: admission.secret,
                                lease_id: admission.lease_id,
                                expires_at: admission.expires_at,
                                renew,
                            },
                            generation,
                            closed_tx.clone(),
                            inbound_budget.clone(),
                            outbound_budget.clone(),
                            policy.write_timeout,
                        );
                        if let Some(first_text) = pending.first_text.take() {
                            let bytes = first_text.len() as u32;
                            let permit = inbound_budget.clone().try_acquire_many_owned(bytes);
                            if permit.is_err()
                                || opened
                                    .inbound
                                    .try_send(session::InboundFrame::metered(
                                        first_text,
                                        permit.unwrap(),
                                    ))
                                    .is_err()
                            {
                                send_channel_close(
                                    &sink,
                                    &channel,
                                    b"channel admission queue closed",
                                    policy.write_timeout,
                                )
                                .await?;
                                continue;
                            }
                        }
                        channels.insert(channel, opened);
                    }
                    Ok(Some(_)) | Ok(None) | Err(_) => {
                        send_channel_close(
                            &sink,
                            &channel,
                            b"channel admission refused",
                            policy.write_timeout,
                        )
                        .await?;
                    }
                }
                continue;
            }
            closed = closed_rx.recv(), if !channels.is_empty() => {
                let Some((channel, generation)) = closed else { continue };
                if channels.get(&channel).is_some_and(|open| open.generation == generation) {
                    channels.remove(&channel);
                }
                continue;
            }
            _ = heartbeat.tick() => {
                if last_message.elapsed() >= policy.read_idle_timeout {
                    anyhow::bail!("the Hub uplink received no heartbeat before its deadline");
                }
                send_with_deadline(&sink, Message::Ping(Vec::new()), policy.write_timeout)
                    .await
                    .context("sending the Hub heartbeat")?;
                continue;
            }
        };
        let Some(message) = message else { break };
        last_message = Instant::now();
        let data = match message.context("reading from the Hub")? {
            Message::Binary(data) => data,
            Message::Close(frame) => {
                if frame
                    .as_ref()
                    .is_some_and(|close| matches!(u16::from(close.code), 4401 | 4403))
                {
                    exit = UplinkExit::Revoked;
                }
                break;
            }
            // Ping and pong are handled underneath; the Hub never sends text.
            _ => continue,
        };

        if data.len() < HEADER_BYTES {
            anyhow::bail!("the Hub sent a frame shorter than its header");
        }
        let kind = data[0];
        let channel = hex(&data[1..HEADER_BYTES]);
        let payload = &data[HEADER_BYTES..];

        match kind {
            KIND_OPEN => {
                // Route ids are unique for the lifetime of a channel. Reusing
                // one cannot safely mean "replace": dropping the old map
                // entry aborts the only task that would otherwise tell Relay
                // the old browser socket is finished.
                if channels.contains_key(&channel) || pending_channels.contains_key(&channel) {
                    pending_channels.remove(&channel);
                    close_local_channel(
                        &mut channels,
                        &sink,
                        &channel,
                        b"duplicate channel open",
                        policy.write_timeout,
                    )
                    .await?;
                    continue;
                }
                if channels.len() + pending_channels.len() >= MAX_CHANNELS {
                    send_channel_close(
                        &sink,
                        &channel,
                        b"channel capacity exceeded",
                        policy.write_timeout,
                    )
                    .await
                    .context("refusing an excess Hub channel")?;
                    continue;
                }
                if let Some(provider) = &channel_provider {
                    let capability = match std::str::from_utf8(payload) {
                        Ok(value)
                            if (1..=128).contains(&value.len())
                                && value.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
                                }) =>
                        {
                            value.to_string()
                        }
                        _ => {
                            send_channel_close(
                                &sink,
                                &channel,
                                b"invalid channel capability",
                                policy.write_timeout,
                            )
                            .await?;
                            continue;
                        }
                    };
                    if admission_window.elapsed() >= Duration::from_secs(60) {
                        admission_window = Instant::now();
                        admission_attempts = 0;
                    }
                    if pending_channels.len() >= MAX_PENDING_CHANNEL_ADMISSIONS
                        || admission_attempts >= MAX_CHANNEL_ADMISSIONS_PER_MINUTE
                    {
                        send_channel_close(
                            &sink,
                            &channel,
                            b"channel admission busy",
                            policy.write_timeout,
                        )
                        .await?;
                        continue;
                    }
                    admission_attempts += 1;
                    let provider = provider.clone();
                    let sender = admitted_tx.clone();
                    let admitted_channel = channel.clone();
                    let admitted_capability = capability.clone();
                    next_generation = next_generation
                        .checked_add(1)
                        .context("uplink channel generation exhausted")?;
                    let generation = next_generation;
                    let task = tokio::spawn(async move {
                        let result = provider(admitted_capability.clone()).await;
                        let _ = sender
                            .send((admitted_channel, generation, admitted_capability, result))
                            .await;
                    });
                    pending_channels.insert(
                        channel,
                        PendingChannel {
                            generation,
                            capability,
                            first_text: None,
                            task,
                        },
                    );
                    continue;
                }
                next_generation = next_generation
                    .checked_add(1)
                    .context("uplink channel generation exhausted")?;
                let opened = open_channel(
                    state,
                    pty,
                    sink.clone(),
                    channel.clone(),
                    admission.clone(),
                    next_generation,
                    closed_tx.clone(),
                    inbound_budget.clone(),
                    outbound_budget.clone(),
                    policy.write_timeout,
                );
                channels.insert(channel, opened);
            }
            KIND_TEXT => {
                if channels.contains_key(&channel) {
                    let text = match std::str::from_utf8(payload).map(str::to_owned) {
                        Ok(text) => text,
                        Err(_) => {
                            close_local_channel(
                                &mut channels,
                                &sink,
                                &channel,
                                b"invalid UTF-8 channel frame",
                                policy.write_timeout,
                            )
                            .await?;
                            continue;
                        }
                    };
                    let permit = match inbound_budget
                        .clone()
                        .try_acquire_many_owned(payload.len() as u32)
                    {
                        Ok(permit) => permit,
                        Err(_) => {
                            close_local_channel(
                                &mut channels,
                                &sink,
                                &channel,
                                b"uplink receive budget exceeded",
                                policy.write_timeout,
                            )
                            .await?;
                            continue;
                        }
                    };
                    let delivered = channels
                        .get(&channel)
                        .expect("the active channel was checked above")
                        .inbound
                        .try_send(session::InboundFrame::metered(text, permit))
                        .is_ok();
                    if !delivered {
                        close_local_channel(
                            &mut channels,
                            &sink,
                            &channel,
                            b"channel receive queue exceeded",
                            policy.write_timeout,
                        )
                        .await?;
                    }
                } else if let Some(pending) = pending_channels.get_mut(&channel) {
                    let first = payload.len() <= MAX_PENDING_FIRST_FRAME_BYTES
                        && pending.first_text.is_none()
                        && std::str::from_utf8(payload).is_ok();
                    if first {
                        pending.first_text = Some(std::str::from_utf8(payload).unwrap().to_owned());
                    } else {
                        pending_channels.remove(&channel);
                        send_channel_close(
                            &sink,
                            &channel,
                            b"invalid pending channel frame",
                            policy.write_timeout,
                        )
                        .await?;
                    }
                }
            }
            // The client protocol is text. A binary frame is a client bug or a
            // future feature; either way, dropping it beats guessing.
            KIND_BINARY => {}
            KIND_CLOSE => {
                tracing::info!(
                    channel,
                    reason = %String::from_utf8_lossy(payload),
                    "the Hub closed a client channel"
                );
                channels.remove(&channel);
                if let Some(pending) = pending_channels.remove(&channel) {
                    pending.task.abort();
                }
            }
            other => anyhow::bail!("the Hub sent an unknown frame kind {other}"),
        }
    }

    drop(channels);
    drop(pending_channels);
    Ok(exit)
}

struct PendingChannel {
    generation: u64,
    capability: String,
    first_text: Option<String>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for PendingChannel {
    fn drop(&mut self) {
        self.task.abort();
    }
}

fn take_matching_pending(
    pending: &mut HashMap<String, PendingChannel>,
    channel: &str,
    generation: u64,
    capability: &str,
) -> Option<PendingChannel> {
    let matches_current = pending.get(channel).is_some_and(|reservation| {
        reservation.generation == generation && reservation.capability == capability
    });
    matches_current.then(|| pending.remove(channel)).flatten()
}

struct Channel {
    generation: u64,
    inbound: mpsc::Sender<session::InboundFrame>,
    task: tokio::task::JoinHandle<()>,
    session_abort: tokio::task::AbortHandle,
    writer_abort: tokio::task::AbortHandle,
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.task.abort();
        self.session_abort.abort();
        self.writer_abort.abort();
    }
}

type Sink = Arc<
    Mutex<
        futures_util::stream::SplitSink<
            tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            Message,
        >,
    >,
>;

#[allow(clippy::too_many_arguments)]
fn open_channel(
    state: &Shared,
    pty: &broadcast::Sender<ServerFrame>,
    sink: Sink,
    channel: String,
    admission: Admission,
    generation: u64,
    closed: mpsc::Sender<(String, u64)>,
    _inbound_budget: Arc<Semaphore>,
    outbound_budget: Arc<Semaphore>,
    write_timeout: Duration,
) -> Channel {
    let (inbound, inbound_rx) =
        mpsc::channel::<session::InboundFrame>(session::SESSION_QUEUE_CAPACITY);
    let (outbound, mut outbound_rx) = session::outbound_channel(outbound_budget);

    let writer_channel = channel.clone();
    let closer = sink.clone();
    let mut writer = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            let framed = encode(KIND_TEXT, &writer_channel, frame.text.as_bytes());
            if send_with_deadline(&sink, Message::Binary(framed), write_timeout)
                .await
                .is_err()
            {
                break;
            }
        }
    });
    let writer_abort = writer.abort_handle();

    // A relayed client never had the daemon's local token, so it is admitted
    // on other grounds: either someone with the authority vouched for it, or
    // it presents a credential this machine issued (see `Admission`).
    let mut loop_task = tokio::spawn(session::drive(
        state.clone(),
        TransportKind::Forwarded,
        admission,
        session::Channels {
            inbound: inbound_rx,
            outbound,
            pty: pty.subscribe(),
        },
    ));
    let session_abort = loop_task.abort_handle();

    let task = tokio::spawn(async move {
        let session_finished = tokio::select! {
            _ = &mut loop_task => true,
            _ = &mut writer => false,
        };
        if session_finished {
            // `drive` can deliberately finish immediately after enqueueing a
            // final response (the one-shot pairing claim is the important
            // case). Its Outbound senders are gone now, so let the writer
            // drain that bounded queue before CLOSE. Aborting it here races
            // the response and turns a successful claim into a closed socket.
            // The outer deadline also bounds the *whole* drain: otherwise a
            // peer that accepts every frame just below the per-write timeout
            // could multiply that timeout by the queue capacity.
            if tokio::time::timeout(write_timeout, &mut writer)
                .await
                .is_err()
            {
                writer.abort();
            }
        } else {
            loop_task.abort();
        }
        // Telling the relay the channel is over is what turns "the daemon
        // stopped answering" into a closed socket at the other end. Without it
        // a revoked device sits waiting for a reply that will never come, which
        // looks like a hang rather than a revocation.
        let _ = send_channel_close(&closer, &channel, b"", write_timeout).await;
        let _ = closed.try_send((channel, generation));
    });

    Channel {
        generation,
        inbound,
        task,
        session_abort,
        writer_abort,
    }
}

async fn send_with_deadline(sink: &Sink, message: Message, deadline: Duration) -> Result<()> {
    tokio::time::timeout(deadline, async {
        let mut sink = sink.lock().await;
        sink.send(message).await
    })
    .await
    .context("the Hub uplink write timed out")?
    .context("writing to the Hub uplink")
}

/// Ends one browser's channel, and says why in the log.
///
/// The reason travels to Relay but no further: the browser is told its socket
/// closed and nothing else, so its request fails with an unknown outcome. This
/// side is the only place the cause is ever written down.
async fn send_channel_close(
    sink: &Sink,
    channel: &str,
    reason: &'static [u8],
    write_timeout: Duration,
) -> Result<()> {
    tracing::info!(
        channel,
        reason = %String::from_utf8_lossy(reason),
        "closing a client channel"
    );
    send_with_deadline(
        sink,
        Message::Binary(encode(KIND_CLOSE, channel, reason)),
        write_timeout,
    )
    .await
    .context("closing a Hub channel")
}

/// Tears down one local channel and explicitly tells Relay that the matching
/// browser socket is over.
///
/// `Channel::drop` aborts its supervisor to stop every child task immediately.
/// That supervisor normally sends CLOSE when the protocol loop finishes, but it
/// cannot be relied on after a local framing or queue failure because the abort
/// cancels its cleanup block too. A healthy uplink must therefore carry this
/// bounded close itself; if even that write fails, returning the error forces a
/// whole-uplink reconnect instead of leaving a silent half-open channel.
async fn close_local_channel(
    channels: &mut HashMap<String, Channel>,
    sink: &Sink,
    channel: &str,
    reason: &'static [u8],
    write_timeout: Duration,
) -> Result<()> {
    channels.remove(channel);
    send_channel_close(sink, channel, reason, write_timeout)
        .await
        .context("closing a locally rejected Hub channel")
}

pub(crate) fn validate_uplink_url(value: &str) -> Result<()> {
    let url = reqwest::Url::parse(value).context("parsing the uplink URL")?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        anyhow::bail!("uplink URLs cannot contain credentials, query parameters, or fragments");
    }
    let host = url
        .host_str()
        .context("the uplink URL has no host")?
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
            "remote uplink credentials require wss; plaintext ws is allowed only for a literal loopback IP"
        ),
        other => anyhow::bail!("unsupported uplink URL scheme '{other}'"),
    }
}

fn jittered_backoff(seconds: u64) -> Duration {
    let base_ms = seconds.saturating_mul(1_000);
    let spread_ms = seconds.saturating_mul(250).max(1);
    let random = uuid::Uuid::new_v4().as_u128() as u64;
    Duration::from_millis(base_ms.saturating_add(random % spread_ms))
}

fn encode(kind: u8, channel: &str, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.push(kind);
    frame.extend_from_slice(&unhex(channel));
    frame.extend_from_slice(payload);
    frame
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> [u8; CHANNEL_ID_BYTES] {
    let mut out = [0u8; CHANNEL_ID_BYTES];
    for (index, slot) in out.iter_mut().enumerate() {
        let at = index * 2;
        *slot = value
            .get(at..at + 2)
            .and_then(|pair| u8::from_str_radix(pair, 16).ok())
            .unwrap_or(0);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    use crate::channel_auth::{self, Direction, SessionKey};
    use genehub_proto::{ChannelAuth, Reply, Request, PROTOCOL_VERSION};

    type TestSocket = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    const TEST_CAPABILITY: &str = "capability-uplink-mux-test";
    const TEST_CHANNEL_SECRET: &str = "uplink-mux-test-channel-secret";

    async fn test_state() -> Shared {
        let directory = tempfile::tempdir().unwrap();
        crate::AppState::build(crate::config::Paths::new(directory.keep()))
            .await
            .unwrap()
            .0
    }

    fn fast_policy() -> UplinkPolicy {
        UplinkPolicy {
            connect_timeout: Duration::from_secs(1),
            heartbeat_interval: Duration::from_millis(10),
            read_idle_timeout: Duration::from_millis(35),
            write_timeout: Duration::from_millis(25),
        }
    }

    fn mux_test_policy() -> UplinkPolicy {
        UplinkPolicy {
            connect_timeout: Duration::from_secs(1),
            heartbeat_interval: Duration::from_millis(100),
            read_idle_timeout: Duration::from_secs(3),
            write_timeout: Duration::from_millis(500),
        }
    }

    fn hosted_test_admission() -> Admission {
        let renew: ChannelLeaseProvider =
            Arc::new(|_| Box::pin(std::future::pending::<Result<Option<Instant>>>()));
        Admission::Hosted {
            capability_id: TEST_CAPABILITY.into(),
            secret: TEST_CHANNEL_SECRET.into(),
            lease_id: "lease-uplink-mux-test".into(),
            expires_at: Instant::now() + Duration::from_secs(60),
            renew,
        }
    }

    fn envelope(id: &str, request: Request) -> String {
        let mut value = serde_json::to_value(request).unwrap();
        value
            .as_object_mut()
            .expect("requests serialize to JSON objects")
            .insert("id".into(), serde_json::Value::String(id.into()));
        serde_json::to_string(&value).unwrap()
    }

    fn hello_envelope(id: &str, client_nonce: &str) -> String {
        let context = channel_auth::hosted_context(TEST_CAPABILITY);
        envelope(
            id,
            Request::Hello {
                client_name: "uplink-mux-test".into(),
                protocol_version: PROTOCOL_VERSION,
                device: None,
                channel: Some(ChannelAuth {
                    capability_id: TEST_CAPABILITY.into(),
                    nonce: client_nonce.into(),
                    proof: channel_auth::client_proof(TEST_CHANNEL_SECRET, &context, client_nonce),
                }),
                invite: None,
            },
        )
    }

    fn authenticated_envelope(
        id: &str,
        request: Request,
        key: &SessionKey,
        sequence: u64,
    ) -> String {
        let plaintext = envelope(id, request);
        let (body, mac) =
            channel_auth::seal_frame(key, Direction::ClientToDaemon, sequence, &plaintext).unwrap();
        envelope(
            id,
            Request::Authenticated {
                sequence,
                body,
                mac,
            },
        )
    }

    async fn send_mux(socket: &mut TestSocket, kind: u8, channel: &str, payload: &[u8]) {
        socket
            .send(Message::Binary(encode(kind, channel, payload)))
            .await
            .unwrap();
    }

    async fn next_mux(socket: &mut TestSocket) -> (u8, String, Vec<u8>) {
        loop {
            let message = tokio::time::timeout(Duration::from_secs(3), socket.next())
                .await
                .expect("the uplink must not hang while closing one channel")
                .expect("the uplink closed before the expected mux frame")
                .expect("reading the test uplink failed");
            match message {
                Message::Binary(data) => {
                    assert!(data.len() >= HEADER_BYTES, "short daemon mux frame");
                    return (
                        data[0],
                        hex(&data[1..HEADER_BYTES]),
                        data[HEADER_BYTES..].to_vec(),
                    );
                }
                Message::Ping(payload) => {
                    socket.send(Message::Pong(payload)).await.unwrap();
                }
                Message::Pong(_) | Message::Text(_) | Message::Frame(_) => {}
                Message::Close(frame) => {
                    panic!("the whole uplink closed before the channel did: {frame:?}")
                }
            }
        }
    }

    async fn open_hosted_channel(
        socket: &mut TestSocket,
        channel: &str,
        request_id: &str,
        client_nonce: &str,
    ) -> SessionKey {
        send_mux(socket, KIND_OPEN, channel, b"").await;
        send_mux(
            socket,
            KIND_TEXT,
            channel,
            hello_envelope(request_id, client_nonce).as_bytes(),
        )
        .await;

        let (kind, reply_channel, payload) = next_mux(socket).await;
        assert_eq!(kind, KIND_TEXT);
        assert_eq!(reply_channel, channel);
        let frame: ServerFrame = serde_json::from_slice(&payload).unwrap();
        let ServerFrame::Result {
            id,
            ok: true,
            payload: Some(Reply::Hello(hello)),
            error: None,
        } = frame
        else {
            panic!("expected a successful Hello on {channel}")
        };
        assert_eq!(id, request_id);
        let server_nonce = hello.server_nonce.expect("keyed Hello has a server nonce");
        let context = channel_auth::hosted_context(TEST_CAPABILITY);
        channel_auth::verify_proof(
            &channel_auth::server_proof(TEST_CHANNEL_SECRET, &context, client_nonce, &server_nonce),
            hello.proof.as_deref().expect("keyed Hello has a proof"),
        )
        .unwrap();
        channel_auth::derive_key(TEST_CHANNEL_SECRET, &context, client_nonce, &server_nonce)
    }

    async fn start_test_uplink(
        listener: tokio::net::TcpListener,
    ) -> (TestSocket, tokio::task::JoinHandle<Result<UplinkExit>>) {
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let state = test_state().await;
        let (pty, _) = broadcast::channel(4);
        let mut link = crate::link::Link::new(state.paths.clone(), pty.clone());
        link.attach(&state).await;
        assert!(state.link.set(link).is_ok());
        let client = tokio::spawn(async move {
            let online = AtomicBool::new(false);
            run_with_policy(
                &state,
                &pty,
                &url,
                "ticket",
                &online,
                hosted_test_admission(),
                None,
                None,
                mux_test_policy(),
            )
            .await
        });
        let (stream, _) = listener.accept().await.unwrap();
        let socket = tokio_tungstenite::accept_async(stream).await.unwrap();
        (socket, client)
    }

    async fn finish_test_uplink(
        mut socket: TestSocket,
        client: tokio::task::JoinHandle<Result<UplinkExit>>,
    ) {
        socket.close(None).await.unwrap();
        let exit = tokio::time::timeout(Duration::from_secs(3), client)
            .await
            .expect("the daemon noticed the test Relay close")
            .unwrap()
            .unwrap();
        assert_eq!(exit, UplinkExit::Reconnect);
    }

    #[test]
    fn a_channel_id_survives_the_round_trip() {
        let id = "0123456789abcdef0123456789abcdef";
        assert_eq!(hex(&unhex(id)), id);
    }

    #[test]
    fn the_header_is_a_kind_then_the_channel() {
        let frame = encode(KIND_TEXT, "000102030405060708090a0b0c0d0e0f", b"hi");
        assert_eq!(frame[0], KIND_TEXT);
        assert_eq!(&frame[1..3], &[0x00, 0x01]);
        assert_eq!(&frame[HEADER_BYTES..], b"hi");
    }

    #[test]
    fn reconnect_backoff_is_jittered_but_bounded() {
        for _ in 0..128 {
            let delay = jittered_backoff(10);
            assert!(delay >= Duration::from_secs(10));
            assert!(delay < Duration::from_millis(12_500));
        }
    }

    #[test]
    fn credentialed_uplinks_require_wss_except_literal_loopback() {
        for accepted in [
            "wss://relay.example/forward/daemon",
            "ws://127.0.0.1:9000/forward/daemon",
            "ws://127.8.9.10/forward/daemon",
            "ws://[::1]:9000/forward/daemon",
        ] {
            assert!(validate_uplink_url(accepted).is_ok(), "{accepted}");
        }
        for rejected in [
            "ws://localhost/forward/daemon",
            "ws://192.168.1.2/forward/daemon",
            "ws://relay.example/forward/daemon",
            "wss://user:pass@relay.example/forward/daemon",
            "wss://relay.example/forward/daemon?ticket=secret",
            "wss://relay.example/forward/daemon#fragment",
            "https://relay.example/forward/daemon",
        ] {
            assert!(validate_uplink_url(rejected).is_err(), "{rejected}");
        }
    }

    #[tokio::test]
    async fn invalid_utf8_closes_only_its_mux_channel() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut socket, client) = start_test_uplink(listener).await;
        let bad_channel = "11111111111111111111111111111111";
        let good_channel = "22222222222222222222222222222222";

        send_mux(&mut socket, KIND_OPEN, bad_channel, b"").await;
        send_mux(&mut socket, KIND_TEXT, bad_channel, &[0xff]).await;
        let (kind, channel, reason) = next_mux(&mut socket).await;
        assert_eq!(kind, KIND_CLOSE);
        assert_eq!(channel, bad_channel);
        assert_eq!(reason, b"invalid UTF-8 channel frame");

        open_hosted_channel(
            &mut socket,
            good_channel,
            "hello-after-invalid-utf8",
            "00112233445566778899aabbccddeeff",
        )
        .await;

        finish_test_uplink(socket, client).await;
    }

    #[tokio::test]
    async fn a_full_session_queue_closes_only_its_mux_channel() {
        let blocker = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let blocker_url = format!("http://{}", blocker.local_addr().unwrap());
        let (accepted_tx, accepted_rx) = tokio::sync::oneshot::channel();
        let blocker_task = tokio::spawn(async move {
            let (_stream, _) = blocker.accept().await.unwrap();
            accepted_tx.send(()).unwrap();
            std::future::pending::<()>().await;
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let (mut socket, client) = start_test_uplink(listener).await;
        let busy_channel = "33333333333333333333333333333333";
        let good_channel = "44444444444444444444444444444444";
        let key = open_hosted_channel(
            &mut socket,
            busy_channel,
            "hello-before-queue-burst",
            "11223344556677889900aabbccddeeff",
        )
        .await;

        let blocking = authenticated_envelope(
            "blocking-hub-pair",
            Request::HubPair {
                hub_url: blocker_url,
                display_name: Some("blocked mux request".into()),
            },
            &key,
            1,
        );
        send_mux(&mut socket, KIND_TEXT, busy_channel, blocking.as_bytes()).await;
        tokio::pin!(accepted_rx);
        tokio::select! {
            accepted = &mut accepted_rx => {
                accepted.expect("the blocking HTTP listener stayed alive");
            }
            (kind, channel, payload) = next_mux(&mut socket) => {
                let wire = serde_json::from_slice::<ServerFrame>(&payload).unwrap();
                let detail = match wire {
                    ServerFrame::Authenticated { sequence, body, mac } => {
                        channel_auth::open_frame(
                            &key,
                            Direction::DaemonToClient,
                            sequence,
                            &body,
                            &mac,
                        )
                        .unwrap()
                    }
                    other => format!("{other:?}"),
                };
                panic!(
                    "the busy request answered before blocking: kind={kind} channel={channel} payload={detail}",
                );
            }
            _ = tokio::time::sleep(Duration::from_secs(3)) => {
                panic!("the blocking request did not reach its local HTTP peer");
            }
        }

        // The router is waiting for the HTTP response above. Four frames fill
        // its bounded queue; the next one must fail this channel closed rather
        // than stalling every channel on the shared uplink.
        for sequence in 2..=(session::SESSION_QUEUE_CAPACITY as u64 + 2) {
            let id = format!("queued-{sequence}");
            let queued = authenticated_envelope(&id, Request::ConnectionIdentity, &key, sequence);
            send_mux(&mut socket, KIND_TEXT, busy_channel, queued.as_bytes()).await;
        }

        let (kind, channel, reason) = next_mux(&mut socket).await;
        assert_eq!(kind, KIND_CLOSE);
        assert_eq!(channel, busy_channel);
        assert_eq!(reason, b"channel receive queue exceeded");

        open_hosted_channel(
            &mut socket,
            good_channel,
            "hello-after-queue-burst",
            "22334455667788990011aabbccddeeff",
        )
        .await;

        finish_test_uplink(socket, client).await;
        blocker_task.abort();
    }

    #[tokio::test]
    async fn a_late_admission_cannot_remove_its_replacement() {
        let mut pending = HashMap::new();
        pending.insert(
            "channel".into(),
            PendingChannel {
                generation: 2,
                capability: "capability-b".into(),
                first_text: Some("hello-b".into()),
                task: tokio::spawn(std::future::pending()),
            },
        );

        assert!(take_matching_pending(&mut pending, "channel", 1, "capability-a").is_none());
        let current = pending.get("channel").expect("B remains reserved");
        assert_eq!(current.generation, 2);
        assert_eq!(current.capability, "capability-b");
        assert_eq!(current.first_text.as_deref(), Some("hello-b"));
    }

    #[tokio::test]
    async fn an_explicit_revocation_is_terminal_instead_of_a_retry_storm() {
        use std::borrow::Cow;
        use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
        use tokio_tungstenite::tungstenite::protocol::CloseFrame;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket
                .close(Some(CloseFrame {
                    code: CloseCode::Library(4403),
                    reason: Cow::Borrowed("revoked"),
                }))
                .await
                .unwrap();
        });
        let (pty, _) = broadcast::channel(4);
        let online = AtomicBool::new(false);

        let exit = run_with_policy(
            &test_state().await,
            &pty,
            &url,
            "ticket",
            &online,
            Admission::Vouched,
            None,
            None,
            fast_policy(),
        )
        .await
        .unwrap();

        assert_eq!(exit, UplinkExit::Revoked);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn a_half_open_uplink_is_detected_by_the_read_idle_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let _socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            tokio::time::sleep(Duration::from_secs(1)).await;
        });
        let (pty, _) = broadcast::channel(4);
        let online = AtomicBool::new(false);

        let error = tokio::time::timeout(
            Duration::from_secs(1),
            run_with_policy(
                &test_state().await,
                &pty,
                &url,
                "ticket",
                &online,
                Admission::Vouched,
                None,
                None,
                fast_policy(),
            ),
        )
        .await
        .expect("the client enforces its own idle deadline")
        .unwrap_err();

        assert!(format!("{error:#}").contains("received no heartbeat"));
        server.abort();
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)]
    async fn every_managed_reconnect_uses_a_fresh_ticket_and_never_the_long_secret() {
        use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("ws://{}/forward/daemon", listener.local_addr().unwrap());
        let (seen_tx, mut seen_rx) = mpsc::unbounded_channel::<String>();
        let server = tokio::spawn(async move {
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                let capture = seen_tx.clone();
                let mut socket = tokio_tungstenite::accept_hdr_async(
                    stream,
                    move |request: &Request, response: Response| {
                        let authorization = request
                            .headers()
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default();
                        capture
                            .send(format!("{}\n{authorization}", request.uri()))
                            .unwrap();
                        Ok(response)
                    },
                )
                .await
                .unwrap();
                socket.close(None).await.unwrap();
            }
        });

        let reusable_secret = Arc::new(String::from("long-lived-enrollment-secret"));
        let calls = Arc::new(AtomicUsize::new(0));
        let (pty, _) = broadcast::channel(4);
        let uplink = Uplink::start_refreshing(
            test_state().await,
            pty,
            url,
            {
                let calls = calls.clone();
                let reusable_secret = reusable_secret.clone();
                move || {
                    let attempt = calls.fetch_add(1, Ordering::SeqCst);
                    let reusable_secret = reusable_secret.clone();
                    async move {
                        // A real provider presents this only to Control HTTPS.
                        // Holding it here makes the negative handshake assertion
                        // meaningful without teaching this transport about it.
                        assert!(!reusable_secret.is_empty());
                        Ok(match attempt {
                            0 => Some(String::from("one-use-ticket-a")),
                            1 => Some(String::from("one-use-ticket-b")),
                            _ => None,
                        })
                    }
                }
            },
            Admission::Vouched,
        );

        tokio::time::timeout(Duration::from_secs(6), uplink.task)
            .await
            .expect("the provider's terminal answer stops the reconnect loop")
            .unwrap();
        server.await.unwrap();

        let first = seen_rx.recv().await.unwrap();
        let second = seen_rx.recv().await.unwrap();
        assert!(first.contains("Bearer one-use-ticket-a"));
        assert!(second.contains("Bearer one-use-ticket-b"));
        assert_ne!(first, second, "a reconnect must not replay an admission");
        assert!(!first.contains(reusable_secret.as_str()));
        assert!(!second.contains(reusable_secret.as_str()));
        assert!(first.starts_with("/forward/daemon\n"));
        assert!(second.starts_with("/forward/daemon\n"));
    }
}
