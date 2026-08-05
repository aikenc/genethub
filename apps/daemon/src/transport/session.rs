//! The client protocol loop, with no opinion about how bytes arrive.
//!
//! A client may reach the daemon over loopback or relayed through the Hub.
//! Those differ in how they are authenticated and framed and
//! in nothing else, so the loop that turns requests into replies lives here and
//! each transport supplies a pair of channels.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use genehub_proto::TransportKind;
use genehub_proto::{parse_envelope, ErrorCode, NoticeLevel, Request, SequencedEvent, ServerFrame};
use tokio::sync::{broadcast, mpsc, OwnedSemaphorePermit, Semaphore};

use crate::channel_auth::{self, Direction, SessionKey};
use crate::router::{self, SideEffect};
use crate::state::Shared;
use crate::transport::uplink::Admission;

/// A slow or hostile peer must not turn inbound work into an unbounded heap.
pub const SESSION_QUEUE_CAPACITY: usize = 4;
/// Legitimate agent turns emit several state transitions in one scheduler
/// slice. Keep enough frame slots for that burst while the byte semaphore below
/// remains the authoritative memory bound for a genuinely slow peer.
const OUTBOUND_QUEUE_CAPACITY: usize = 256;
pub const MAX_BUFFERED_OUTBOUND_BYTES: usize = 16 * 1024 * 1024;
const MAX_SESSION_SUBSCRIPTIONS: usize = 64;

/// A received frame may carry a byte-budget permit owned by its transport.
/// Keeping the permit beside the allocation makes the bound survive queueing;
/// it is released exactly when this loop consumes the text.
pub struct InboundFrame {
    text: String,
    _permit: Option<OwnedSemaphorePermit>,
}

/// An outbound allocation retains its byte permit until the transport writer
/// actually removes it from the queue. The uplink shares one budget across all
/// multiplexed channels, so channel count cannot multiply memory usage.
pub struct OutboundFrame {
    pub(crate) text: String,
    _permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub struct Outbound {
    sender: mpsc::Sender<OutboundFrame>,
    budget: Arc<Semaphore>,
}

pub fn outbound_channel(budget: Arc<Semaphore>) -> (Outbound, mpsc::Receiver<OutboundFrame>) {
    let (sender, receiver) = mpsc::channel(OUTBOUND_QUEUE_CAPACITY);
    (Outbound { sender, budget }, receiver)
}

impl Outbound {
    fn try_send(&self, text: String) -> Result<(), mpsc::error::TrySendError<String>> {
        let bytes =
            u32::try_from(text.len()).map_err(|_| mpsc::error::TrySendError::Full(text.clone()))?;
        let permit = self
            .budget
            .clone()
            .try_acquire_many_owned(bytes)
            .map_err(|_| mpsc::error::TrySendError::Full(text.clone()))?;
        match self.sender.try_send(OutboundFrame {
            text,
            _permit: permit,
        }) {
            Ok(()) => Ok(()),
            Err(mpsc::error::TrySendError::Full(frame)) => {
                Err(mpsc::error::TrySendError::Full(frame.text))
            }
            Err(mpsc::error::TrySendError::Closed(frame)) => {
                Err(mpsc::error::TrySendError::Closed(frame.text))
            }
        }
    }
}

impl InboundFrame {
    pub fn unmetered(text: String) -> Self {
        Self {
            text,
            _permit: None,
        }
    }

    pub fn metered(text: String, permit: OwnedSemaphorePermit) -> Self {
        Self {
            text,
            _permit: Some(permit),
        }
    }
}

/// Everything a transport has to provide.
pub struct Channels {
    /// Text frames from the client, already de-framed.
    pub inbound: mpsc::Receiver<InboundFrame>,
    /// Where replies, events and terminal output go.
    pub outbound: Outbound,
    /// Terminal output for every client on this daemon.
    pub pty: broadcast::Receiver<ServerFrame>,
}

/// Runs one client connection to completion.
pub async fn drive(
    state: Shared,
    transport: TransportKind,
    admission: Admission,
    channels: Channels,
) {
    drive_with_handshake_timeout(
        state,
        transport,
        admission,
        channels,
        Duration::from_secs(10),
    )
    .await;
}

async fn drive_with_handshake_timeout(
    state: Shared,
    transport: TransportKind,
    admission: Admission,
    channels: Channels,
    handshake_timeout: Duration,
) {
    let Channels {
        mut inbound,
        outbound,
        mut pty,
    } = channels;

    // Subscribed before the handshake so that a revocation racing with it
    // cannot slip through the gap.
    let mut revocations = state.devices.subscribe_revocations();
    let mut device: Option<String> = None;

    let mut subscriptions: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut greeted = false;
    let mut business_ready = false;
    let mut inbound_authentication: Option<(SessionKey, u64)> = None;
    let mut bootstrap_invite: Option<String> = None;
    let outbound_authentication = Arc::new(Mutex::new(OutboundAuthentication::default()));
    let handshake_deadline = tokio::time::sleep(handshake_timeout);
    tokio::pin!(handshake_deadline);
    let key_confirmation_deadline = tokio::time::sleep(handshake_timeout * 2);
    tokio::pin!(key_confirmation_deadline);
    let mut lease_watchdog = match &admission {
        Admission::Hosted {
            lease_id,
            expires_at,
            renew,
            ..
        } => Some(tokio::spawn(enforce_hosted_lease(
            lease_id.clone(),
            *expires_at,
            renew.clone(),
        ))),
        Admission::Vouched | Admission::Loopback { .. } | Admission::DeviceRequired => None,
    };
    let (subscription_failed, mut subscription_failures) =
        mpsc::channel::<()>(SESSION_QUEUE_CAPACITY);

    loop {
        let text = tokio::select! {
            message = inbound.recv() => match message {
                Some(frame) => frame.text,
                None => break,
            },
            // Revoking a device has to reach the connection it is using, or
            // "revoked" would only mean "cannot come back", which is not what
            // anyone pressing that button intends.
            revoked = revocations.recv() => {
                match revoked {
                    Ok(id) if Some(&id) == device.as_ref() => {
                        let _ = send_frame(&outbound, &outbound_authentication, ServerFrame::Notice {
                            level: NoticeLevel::Error,
                            message: "这台设备的授权已被撤销".into(),
                        }, false);
                        break;
                    }
                    Ok(_) => continue,
                    // Once revocation history was lost, this connection can no
                    // longer prove its own credential was not among it.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            // A socket that never authenticates must not hold a channel and
            // its queues forever. More importantly, terminal output is never
            // selected before a successful Hello: merely reaching a relay
            // slot is not permission to observe the user's shell.
            _ = &mut handshake_deadline, if !greeted => break,
            _ = &mut key_confirmation_deadline, if greeted && !business_ready => break,
            // Relay is not a revocation authority. Renewal and the hard local
            // deadline run independently of request handlers, including a
            // command that remains pending for the whole lease interval.
            _ = wait_for_lease_watchdog(&mut lease_watchdog),
                if lease_watchdog.is_some() => break,
            terminal = pty.recv(), if business_ready => {
                match terminal {
                    Ok(frame) => {
                        if send_frame(&outbound, &outbound_authentication, frame, false).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    // Missing terminal bytes cannot be reconstructed safely.
                    // Close the channel so the UI reconnects instead of
                    // displaying a silently corrupted terminal stream.
                    Err(broadcast::error::RecvError::Lagged(_)) => break,
                }
                continue;
            }
            failed = subscription_failures.recv(), if !subscriptions.is_empty() => {
                let _ = failed;
                // A subscription pump that cannot enqueue means this channel
                // is no longer delivering its promised event stream. Closing
                // turns that hidden half-open state into a reconnect/resync.
                break;
            }
        };

        let mut envelope = match parse_envelope(&text) {
            Ok(envelope) => envelope,
            Err((id, error)) => {
                if greeted && inbound_authentication.is_some() {
                    break;
                }
                let _ = send_frame(
                    &outbound,
                    &outbound_authentication,
                    ServerFrame::Result {
                        id: id.unwrap_or_else(|| "unknown".into()),
                        ok: false,
                        payload: None,
                        error: Some(error),
                    },
                    true,
                );
                continue;
            }
        };

        if let Request::Authenticated {
            sequence,
            body,
            mac,
        } = &envelope.request
        {
            let Some((key, previous)) = inbound_authentication.as_mut() else {
                break;
            };
            let Some(expected) = previous.checked_add(1) else {
                break;
            };
            if *sequence != expected {
                break;
            }
            let plaintext = match channel_auth::open_frame(
                key,
                Direction::ClientToDaemon,
                *sequence,
                body,
                mac,
            ) {
                Ok(plaintext) => plaintext,
                Err(_) => break,
            };
            if plaintext.len() > genehub_proto::MAX_AUTHENTICATED_PLAINTEXT_BYTES {
                break;
            }
            let inner = match parse_envelope(&plaintext) {
                Ok(inner) if inner.id == envelope.id => inner,
                _ => break,
            };
            if matches!(
                inner.request,
                Request::Hello { .. } | Request::Authenticated { .. }
            ) || (matches!(inner.request, Request::DeviceClaim { .. })
                && bootstrap_invite.is_none())
            {
                break;
            }
            *previous = expected;
            envelope = inner;
            // Possession of the freshly derived channel key is the third
            // handshake stage. From here broadcasts are safe and the key-
            // confirmation timeout must no longer tear down a healthy remote.
            business_ready = true;
        } else if greeted && inbound_authentication.is_some() {
            // A Relay can copy a valid Hello, but an unsigned request after it
            // is rejected before router dispatch and therefore before effects.
            break;
        }

        if transport == TransportKind::Forwarded
            && matches!(envelope.request, Request::DeviceClaim { .. })
            && bootstrap_invite.is_none()
        {
            // Claim returns a new long-lived secret. An unauthenticated relay
            // must never be allowed to observe that bootstrap response.
            break;
        }

        if !greeted && router::needs_handshake(&envelope.request) {
            let _ = send_frame(
                &outbound,
                &outbound_authentication,
                ServerFrame::err(
                    envelope.id,
                    ErrorCode::Unauthorized,
                    "send hello before anything else",
                ),
                true,
            );
            continue;
        }

        let is_hello = matches!(&envelope.request, Request::Hello { .. });
        let is_identity = matches!(&envelope.request, Request::ConnectionIdentity);
        if bootstrap_invite.is_some() && !matches!(envelope.request, Request::DeviceClaim { .. }) {
            break;
        }

        if let (
            Some(invite_id),
            Request::DeviceClaim {
                code, device_name, ..
            },
        ) = (bootstrap_invite.as_deref(), &envelope.request)
        {
            if code != invite_id {
                break;
            }
            let frame = match state.devices.claim_authenticated(invite_id, device_name) {
                Ok((mut credential, _)) => {
                    credential.machine_name = crate::link::default_display_name();
                    credential.machine_id = state.machine.machine_id.clone();
                    credential.fingerprint = state.machine.fingerprint();
                    ServerFrame::ok(envelope.id, genehub_proto::Reply::Claimed(credential))
                }
                Err(error) => {
                    ServerFrame::err(envelope.id, ErrorCode::Unauthorized, format!("{error:#}"))
                }
            };
            let _ = send_frame(&outbound, &outbound_authentication, frame, false);
            break;
        }
        let handled = tokio::select! {
            handled = router::handle(&state, transport, &admission, envelope.request) => handled,
            _ = wait_for_lease_watchdog(&mut lease_watchdog),
                if lease_watchdog.is_some() => break,
            revoked = revocations.recv() => {
                match revoked {
                    Ok(id) if Some(&id) == device.as_ref() => break,
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)
                        | broadcast::error::RecvError::Closed) => break,
                }
            }
        };
        if let Some(id) = &handled.device {
            state.devices.mark_connected(id);
            device = Some(id.clone());
        }
        let frame = match handled.reply {
            Ok(reply) => {
                // DeviceClaim is intentionally allowed before Hello, but it
                // only mints a credential. Treating any successful bootstrap
                // request as a greeting let a claimant receive broadcasts
                // without proving the newly issued credential.
                if is_hello {
                    greeted = true;
                }
                if is_identity || (is_hello && handled.authentication.is_none()) {
                    business_ready = true;
                }
                ServerFrame::ok(envelope.id, reply)
            }
            Err(error) => ServerFrame::Result {
                id: envelope.id,
                ok: false,
                payload: None,
                error: Some(error),
            },
        };
        let hello_authentication =
            if is_hello && matches!(frame, ServerFrame::Result { ok: true, .. }) {
                handled.authentication
            } else {
                None
            };
        let hello_bootstrap = if is_hello {
            handled.bootstrap_invite.clone()
        } else {
            None
        };
        if send_frame(&outbound, &outbound_authentication, frame, is_hello).is_err() {
            break;
        }
        if let Some(key) = hello_authentication {
            inbound_authentication = Some((key.clone(), 0));
            let mut auth = outbound_authentication.lock().unwrap();
            auth.key = Some(key);
            auth.sequence = 0;
        }
        if hello_bootstrap.is_some() {
            bootstrap_invite = hello_bootstrap;
        }

        match handled.effect {
            SideEffect::None => {}
            SideEffect::Subscribe {
                session_id,
                receiver,
            } => {
                // Each subscription owns a broadcast receiver and a task. A
                // credentialed but hostile client must not turn an unlimited
                // sequence of unique session ids into unlimited daemon tasks.
                // Replacing an existing topic consumes no additional slot.
                if !subscription_slot_available(&subscriptions, &session_id) {
                    break;
                }
                // Re-subscribing replaces the old pump rather than doubling
                // every event.
                if let Some(previous) = subscriptions.remove(&session_id) {
                    previous.abort();
                }
                let sender = outbound.clone();
                let topic = session_id.clone();
                let task = tokio::spawn(forward_events(
                    topic,
                    receiver,
                    sender,
                    outbound_authentication.clone(),
                    subscription_failed.clone(),
                ));
                subscriptions.insert(session_id, task);
            }
            SideEffect::Unsubscribe { session_id } => {
                if let Some(task) = subscriptions.remove(&session_id) {
                    task.abort();
                }
            }
        }
    }

    for (_, task) in subscriptions {
        task.abort();
    }
    if let Some(task) = lease_watchdog {
        task.abort();
    }
    if let Some(id) = device {
        state.devices.mark_disconnected(&id);
    }
}

fn subscription_slot_available<T>(subscriptions: &HashMap<String, T>, session_id: &str) -> bool {
    subscriptions.contains_key(session_id) || subscriptions.len() < MAX_SESSION_SUBSCRIPTIONS
}

async fn wait_for_lease_watchdog(watchdog: &mut Option<tokio::task::JoinHandle<()>>) {
    if let Some(watchdog) = watchdog {
        let _ = watchdog.await;
    } else {
        std::future::pending::<()>().await;
    }
}

async fn enforce_hosted_lease(
    lease_id: String,
    mut expires_at: std::time::Instant,
    renew: crate::transport::uplink::ChannelLeaseProvider,
) {
    let mut next_attempt = std::time::Instant::now() + renewal_delay(expires_at);
    loop {
        let now = std::time::Instant::now();
        if expires_at <= now {
            return;
        }
        tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)) => return,
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(next_attempt)) => {}
        }
        let renewed = tokio::select! {
            _ = tokio::time::sleep_until(tokio::time::Instant::from_std(expires_at)) => return,
            result = renew(lease_id.clone()) => result,
        };
        match renewed {
            Ok(Some(expiry)) => {
                let now = std::time::Instant::now();
                if expiry <= now {
                    return;
                }
                expires_at = expiry.min(now + Duration::from_secs(600));
                next_attempt = now + renewal_delay(expires_at);
            }
            Ok(None) => return,
            Err(_) => {
                let now = std::time::Instant::now();
                let remaining = expires_at.saturating_duration_since(now);
                if remaining.is_zero() {
                    return;
                }
                next_attempt = now
                    + Duration::from_secs(5)
                        .min(remaining / 2)
                        .max(Duration::from_millis(10));
            }
        }
    }
}

fn renewal_delay(expires_at: std::time::Instant) -> Duration {
    let remaining = expires_at.saturating_duration_since(std::time::Instant::now());
    Duration::from_secs(60)
        .min(remaining / 2)
        .max(Duration::from_millis(10))
}

async fn forward_events(
    session_id: String,
    mut receiver: broadcast::Receiver<SequencedEvent>,
    outbound: Outbound,
    authentication: Arc<Mutex<OutboundAuthentication>>,
    failed: mpsc::Sender<()>,
) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
                if send_frame(
                    &outbound,
                    &authentication,
                    ServerFrame::event(&session_id, event),
                    false,
                )
                .is_err()
                {
                    let _ = failed.try_send(());
                    break;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                // Naming the session and the size of the hole, so the client can
                // close it. This used to be a sentence in English asking the
                // person to reconnect, which left the gap on screen for anyone
                // who did not, and read as an error to everyone who did.
                if send_frame(
                    &outbound,
                    &authentication,
                    ServerFrame::Desync {
                        session_id: session_id.clone(),
                        missed,
                    },
                    false,
                )
                .is_err()
                {
                    let _ = failed.try_send(());
                    break;
                }
            }
        }
    }
}

#[derive(Default)]
struct OutboundAuthentication {
    key: Option<SessionKey>,
    sequence: u64,
    closed: bool,
}

fn send_frame(
    outbound: &Outbound,
    authentication: &Arc<Mutex<OutboundAuthentication>>,
    frame: ServerFrame,
    force_plain: bool,
) -> Result<(), mpsc::error::TrySendError<String>> {
    let mut body = serde_json::to_string(&frame).expect("server frames serialize");
    if body.len() > genehub_proto::MAX_AUTHENTICATED_PLAINTEXT_BYTES {
        let replacement = match frame {
            ServerFrame::Result { id, .. } => ServerFrame::err(
                id,
                ErrorCode::BadRequest,
                "response is too large for one channel frame",
            ),
            _ => ServerFrame::Notice {
                level: NoticeLevel::Error,
                message: "an update was too large for one channel frame; refresh this view".into(),
            },
        };
        body = serde_json::to_string(&replacement).expect("fallback frame serializes");
    }
    if force_plain {
        return outbound.try_send(body);
    }

    // Sequence allocation and queue insertion are one critical section.
    // Otherwise two Tokio workers can allocate 1 then 2 but enqueue 2 then 1,
    // and a correct strict client will close a healthy channel as a replay.
    let mut authentication = authentication.lock().unwrap();
    if authentication.closed {
        return Err(mpsc::error::TrySendError::Closed(String::new()));
    }
    let wire = match authentication.key.clone() {
        Some(key) => {
            let Some(sequence) = authentication.sequence.checked_add(1) else {
                authentication.closed = true;
                return Err(mpsc::error::TrySendError::Closed(String::new()));
            };
            let (body, mac) =
                channel_auth::seal_frame(&key, Direction::DaemonToClient, sequence, &body)
                    .expect("server frame encryption succeeds");
            let wire = serde_json::to_string(&ServerFrame::Authenticated {
                sequence,
                body,
                mac,
            })
            .expect("authenticated server frames serialize");
            authentication.sequence = sequence;
            wire
        }
        None => body,
    };
    if wire.len() > 4 * 1024 * 1024 {
        authentication.closed = true;
        return Err(mpsc::error::TrySendError::Closed(String::new()));
    }
    let sent = outbound.try_send(wire);
    if sent.is_err() {
        // A consumed AEAD nonce whose frame did not enter the queue cannot be
        // retried. Fail the channel closed so no later sequence creates a gap.
        authentication.closed = true;
    }
    sent
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{Reply, PROTOCOL_VERSION};

    async fn state() -> Shared {
        let dir = tempfile::tempdir().unwrap();
        // AppState owns paths for its entire lifetime; keeping this test-only
        // directory avoids deleting them while the protocol task is live.
        let paths = crate::config::Paths::new(dir.keep());
        crate::AppState::build(paths).await.unwrap().0
    }

    fn envelope(id: &str, request: Request) -> String {
        let mut value = serde_json::to_value(request).unwrap();
        value
            .as_object_mut()
            .unwrap()
            .insert("id".into(), serde_json::json!(id));
        value.to_string()
    }

    fn channels() -> (
        mpsc::Sender<InboundFrame>,
        mpsc::Receiver<OutboundFrame>,
        broadcast::Sender<ServerFrame>,
        Channels,
    ) {
        let (inbound_tx, inbound) = mpsc::channel(SESSION_QUEUE_CAPACITY);
        let (outbound, outbound_rx) =
            outbound_channel(Arc::new(Semaphore::new(MAX_BUFFERED_OUTBOUND_BYTES)));
        let (pty, pty_rx) = broadcast::channel(8);
        (
            inbound_tx,
            outbound_rx,
            pty.clone(),
            Channels {
                inbound,
                outbound,
                pty: pty_rx,
            },
        )
    }

    async fn frame(outbound: &mut mpsc::Receiver<OutboundFrame>) -> Option<ServerFrame> {
        outbound
            .recv()
            .await
            .map(|frame| serde_json::from_str(&frame.text).unwrap())
    }

    async fn keyed_session() -> (
        mpsc::Sender<InboundFrame>,
        mpsc::Receiver<OutboundFrame>,
        broadcast::Sender<ServerFrame>,
        tokio::task::JoinHandle<()>,
        SessionKey,
    ) {
        let capability_id = "capability-1";
        let secret = "channel-secret-1";
        let client_nonce = "client-nonce-00000000000000000001";
        let context = channel_auth::hosted_context(capability_id);
        let (inbound, mut outbound, pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::Hosted {
                capability_id: capability_id.into(),
                secret: secret.into(),
                lease_id: "lease-1".into(),
                expires_at: std::time::Instant::now() + Duration::from_secs(60),
                renew: Arc::new(|_| Box::pin(std::future::pending())),
            },
            channels,
            Duration::from_secs(1),
        ));
        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "hello",
                Request::Hello {
                    client_name: "security-test".into(),
                    protocol_version: PROTOCOL_VERSION,
                    device: None,
                    channel: Some(genehub_proto::ChannelAuth {
                        capability_id: capability_id.into(),
                        nonce: client_nonce.into(),
                        proof: channel_auth::client_proof(secret, &context, client_nonce),
                    }),
                    invite: None,
                },
            )))
            .unwrap();
        let hello = match frame(&mut outbound).await {
            Some(ServerFrame::Result {
                ok: true,
                payload: Some(Reply::Hello(hello)),
                ..
            }) => hello,
            other => panic!("expected a successful keyed Hello, got {other:?}"),
        };
        let server_nonce = hello.server_nonce.expect("keyed Hello has a server nonce");
        channel_auth::verify_proof(
            &channel_auth::server_proof(secret, &context, client_nonce, &server_nonce),
            hello.proof.as_deref().expect("keyed Hello has a proof"),
        )
        .unwrap();
        let key = channel_auth::derive_key(secret, &context, client_nonce, &server_nonce);
        (inbound, outbound, pty, task, key)
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

    async fn expect_channel_closed(
        task: tokio::task::JoinHandle<()>,
        outbound: &mut mpsc::Receiver<OutboundFrame>,
    ) {
        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("invalid authenticated traffic must close promptly")
            .unwrap();
        assert!(outbound.recv().await.is_none());
    }

    #[tokio::test]
    async fn unsigned_request_after_keyed_hello_fails_closed() {
        let (inbound, mut outbound, _pty, task, _key) = keyed_session().await;
        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "unsigned",
                Request::ConnectionIdentity,
            )))
            .unwrap();
        expect_channel_closed(task, &mut outbound).await;
    }

    #[tokio::test]
    async fn duplicate_authenticated_sequence_after_keyed_hello_fails_closed() {
        let (inbound, mut outbound, _pty, task, key) = keyed_session().await;
        let request = authenticated_envelope("identity", Request::ConnectionIdentity, &key, 1);
        inbound
            .try_send(InboundFrame::unmetered(request.clone()))
            .unwrap();
        let reply = frame(&mut outbound)
            .await
            .expect("first sequence is accepted");
        let ServerFrame::Authenticated {
            sequence,
            body,
            mac,
        } = reply
        else {
            panic!("keyed response must be authenticated")
        };
        assert_eq!(sequence, 1);
        channel_auth::open_frame(&key, Direction::DaemonToClient, sequence, &body, &mac).unwrap();

        inbound.try_send(InboundFrame::unmetered(request)).unwrap();
        expect_channel_closed(task, &mut outbound).await;
    }

    #[tokio::test]
    async fn out_of_order_authenticated_sequence_after_keyed_hello_fails_closed() {
        let (inbound, mut outbound, _pty, task, key) = keyed_session().await;
        inbound
            .try_send(InboundFrame::unmetered(authenticated_envelope(
                "identity",
                Request::ConnectionIdentity,
                &key,
                2,
            )))
            .unwrap();
        expect_channel_closed(task, &mut outbound).await;
    }

    #[tokio::test]
    async fn wrong_mac_after_keyed_hello_fails_closed() {
        let (inbound, mut outbound, _pty, task, key) = keyed_session().await;
        let plaintext = envelope("identity", Request::ConnectionIdentity);
        let (body, _) =
            channel_auth::seal_frame(&key, Direction::ClientToDaemon, 1, &plaintext).unwrap();
        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "identity",
                Request::Authenticated {
                    sequence: 1,
                    body,
                    mac: "00".repeat(32),
                },
            )))
            .unwrap();
        expect_channel_closed(task, &mut outbound).await;
    }

    #[test]
    fn subscription_slots_are_bounded_reusable_and_do_not_charge_replacements() {
        let mut subscriptions = HashMap::new();
        for index in 0..MAX_SESSION_SUBSCRIPTIONS {
            let session_id = format!("session-{index}");
            assert!(subscription_slot_available(&subscriptions, &session_id));
            subscriptions.insert(session_id, ());
        }
        assert!(!subscription_slot_available(
            &subscriptions,
            "capacity-plus-one"
        ));
        assert!(subscription_slot_available(&subscriptions, "session-0"));

        subscriptions.remove("session-1");
        assert!(subscription_slot_available(
            &subscriptions,
            "after-unsubscribe"
        ));
    }

    #[tokio::test]
    async fn an_ungreeted_connection_never_receives_pty_and_expires() {
        let (inbound, mut outbound, pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::DeviceRequired,
            channels,
            Duration::from_millis(30),
        ));

        pty.send(ServerFrame::PtyOutput {
            pty_id: "pty-secret".into(),
            data: "secret output".into(),
        })
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), outbound.recv())
                .await
                .is_err()
        );

        task.await.unwrap();
        drop(inbound);
        assert!(outbound.recv().await.is_none());
    }

    #[tokio::test]
    async fn a_hosted_channel_expires_without_relay_cooperation() {
        let (inbound, mut outbound, _pty, channels) = channels();
        let started = std::time::Instant::now();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::Hosted {
                capability_id: "capability".into(),
                secret: "secret".into(),
                lease_id: "lease".into(),
                expires_at: std::time::Instant::now() + Duration::from_millis(30),
                renew: Arc::new(|_| Box::pin(std::future::pending())),
            },
            channels,
            Duration::from_secs(5),
        ));

        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("the daemon, not Relay, enforces the lease")
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(inbound);
        assert!(outbound.recv().await.is_none());
    }

    #[tokio::test]
    async fn successful_lease_renewals_keep_a_hosted_channel_alive() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let (inbound, _outbound, _pty, channels) = channels();
        let renew = {
            let calls = calls.clone();
            Arc::new(move |_| {
                calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async { Ok(Some(std::time::Instant::now() + Duration::from_millis(80))) })
                    as crate::transport::uplink::ChannelLeaseFuture
            })
        };
        let mut task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::Hosted {
                capability_id: "capability".into(),
                secret: "secret".into(),
                lease_id: "lease".into(),
                expires_at: std::time::Instant::now() + Duration::from_millis(50),
                renew,
            },
            channels,
            Duration::from_secs(5),
        ));

        tokio::time::timeout(Duration::from_millis(500), async {
            while calls.load(Ordering::SeqCst) < 2 {
                assert!(
                    !task.is_finished(),
                    "renewal extends the local hard deadline"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the hosted lease keeps renewing");
        drop(inbound);
        tokio::time::timeout(Duration::from_millis(100), &mut task)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn a_transient_lease_failure_can_recover_before_the_hard_deadline() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let (inbound, _outbound, _pty, channels) = channels();
        let renew = {
            let calls = calls.clone();
            Arc::new(move |_| {
                let attempt = calls.fetch_add(1, Ordering::SeqCst);
                Box::pin(async move {
                    if attempt == 0 {
                        Err(anyhow::anyhow!("temporary Control outage"))
                    } else {
                        Ok(Some(std::time::Instant::now() + Duration::from_millis(100)))
                    }
                }) as crate::transport::uplink::ChannelLeaseFuture
            })
        };
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::Hosted {
                capability_id: "capability".into(),
                secret: "secret".into(),
                lease_id: "lease".into(),
                expires_at: std::time::Instant::now() + Duration::from_millis(100),
                renew,
            },
            channels,
            Duration::from_secs(5),
        ));

        tokio::time::timeout(Duration::from_millis(500), async {
            while calls.load(Ordering::SeqCst) < 2 {
                assert!(!task.is_finished());
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("the transient failure is retried before lease expiry");
        drop(inbound);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn an_explicit_lease_revocation_closes_immediately() {
        let (inbound, _outbound, _pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Forwarded,
            Admission::Hosted {
                capability_id: "capability".into(),
                secret: "secret".into(),
                lease_id: "lease".into(),
                expires_at: std::time::Instant::now() + Duration::from_millis(60),
                renew: Arc::new(|_| Box::pin(async { Ok(None) })),
            },
            channels,
            Duration::from_secs(5),
        ));

        tokio::time::timeout(Duration::from_millis(100), task)
            .await
            .expect("an explicit Control rejection is terminal")
            .unwrap();
        drop(inbound);
    }

    #[tokio::test]
    async fn only_a_successful_hello_unlocks_pty_broadcasts() {
        let (inbound, mut outbound, pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Loopback,
            Admission::Loopback {
                server_proof: "server-proof".into(),
            },
            channels,
            Duration::from_secs(1),
        ));

        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "hello",
                Request::Hello {
                    client_name: "test".into(),
                    protocol_version: PROTOCOL_VERSION,
                    device: None,
                    channel: None,
                    invite: None,
                },
            )))
            .unwrap();
        assert!(matches!(
            frame(&mut outbound).await,
            Some(ServerFrame::Result {
                ok: true,
                payload: Some(Reply::Hello(_)),
                ..
            })
        ));

        pty.send(ServerFrame::PtyOutput {
            pty_id: "pty-1".into(),
            data: "visible after hello".into(),
        })
        .unwrap();
        assert!(matches!(
            frame(&mut outbound).await,
            Some(ServerFrame::PtyOutput { data, .. }) if data == "visible after hello"
        ));

        drop(inbound);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn an_invite_cannot_be_redeemed_through_an_untrusted_relay() {
        let state = state().await;
        let invite = state.devices.invite();
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let (inbound, mut outbound, _pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state,
            TransportKind::Forwarded,
            Admission::DeviceRequired,
            channels,
            Duration::from_millis(80),
        ));

        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "claim",
                Request::DeviceClaim {
                    code: invite.code.clone(),
                    device_name: "new browser".into(),
                    nonce: nonce.clone(),
                    proof: crate::devices::proof("client", &nonce, &invite.code),
                },
            )))
            .unwrap();
        task.await.unwrap();
        assert!(outbound.recv().await.is_none());

        drop(inbound);
        assert!(outbound.recv().await.is_none());
    }

    #[tokio::test]
    async fn outbound_byte_budget_is_shared_and_held_until_a_frame_is_dropped() {
        let budget = Arc::new(Semaphore::new(5));
        let (outbound, mut receiver) = outbound_channel(budget.clone());
        let another_channel = outbound.clone();

        outbound.try_send("12345".into()).unwrap();
        assert_eq!(budget.available_permits(), 0);
        assert!(matches!(
            another_channel.try_send("x".into()),
            Err(mpsc::error::TrySendError::Full(_))
        ));

        let retained = receiver.recv().await.unwrap();
        assert_eq!(budget.available_permits(), 0);
        drop(retained);
        assert_eq!(budget.available_permits(), 5);
        another_channel.try_send("x".into()).unwrap();
    }

    #[tokio::test]
    async fn a_legitimate_agent_event_burst_does_not_look_like_a_slow_peer() {
        let budget = Arc::new(Semaphore::new(1024));
        let (outbound, mut receiver) = outbound_channel(budget);

        // A turn can synchronously announce lifecycle, tool and streaming
        // updates before the socket writer gets its next scheduler slice. The
        // frame queue must absorb that ordinary burst; the independent byte
        // semaphore remains the hard memory limit for large frames.
        for sequence in 0..32 {
            outbound
                .try_send(format!("event-{sequence}"))
                .expect("an ordinary event burst must remain connected");
        }
        for sequence in 0..32 {
            assert_eq!(
                receiver.recv().await.unwrap().text,
                format!("event-{sequence}")
            );
        }
    }

    #[tokio::test]
    async fn a_saturated_subscription_pump_reports_failure_to_its_owner() {
        let (outbound, _receiver) = outbound_channel(Arc::new(Semaphore::new(1024)));
        for _ in 0..OUTBOUND_QUEUE_CAPACITY {
            outbound.try_send("x".into()).unwrap();
        }
        let (events, event_rx) = broadcast::channel(4);
        let (failed, mut failures) = mpsc::channel(1);
        let task = tokio::spawn(forward_events(
            "s1".into(),
            event_rx,
            outbound,
            Arc::new(Mutex::new(OutboundAuthentication::default())),
            failed,
        ));
        events
            .send(SequencedEvent {
                seq: 1,
                session_id: "s1".into(),
                event: genehub_proto::SessionEvent::TurnStarted {
                    turn_id: "t1".into(),
                    started_at_ms: 0,
                },
            })
            .unwrap();

        tokio::time::timeout(Duration::from_millis(100), failures.recv())
            .await
            .expect("a hidden half-open subscription must fail the connection")
            .expect("the failure sender stays alive through notification");
        task.await.unwrap();
    }

    #[tokio::test]
    async fn lagged_terminal_output_closes_instead_of_silently_losing_bytes() {
        let (inbound, mut outbound, pty, channels) = channels();
        let task = tokio::spawn(drive_with_handshake_timeout(
            state().await,
            TransportKind::Loopback,
            Admission::Loopback {
                server_proof: "server-proof".into(),
            },
            channels,
            Duration::from_secs(1),
        ));
        inbound
            .try_send(InboundFrame::unmetered(envelope(
                "hello",
                Request::Hello {
                    client_name: "test".into(),
                    protocol_version: PROTOCOL_VERSION,
                    device: None,
                    channel: None,
                    invite: None,
                },
            )))
            .unwrap();
        for index in 0..9 {
            pty.send(ServerFrame::PtyOutput {
                pty_id: "pty-1".into(),
                data: format!("chunk-{index}"),
            })
            .unwrap();
        }

        tokio::time::timeout(Duration::from_millis(250), task)
            .await
            .expect("PTY desync must force a reconnect")
            .unwrap();
        assert!(matches!(
            frame(&mut outbound).await,
            Some(ServerFrame::Result { ok: true, .. })
        ));
        assert!(outbound.recv().await.is_none());
        drop(inbound);
    }
}
