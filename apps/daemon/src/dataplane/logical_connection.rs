//! One process-local ordered connection actor between channels and streams.
use super::authenticated_channel::{
    authenticated_channel, AuthenticatedReader, AuthenticatedWriter, Role,
};
use super::endpoint::{Carrier, CarrierKind, PeerAccess};
use super::frame::{Frame, Kind};
use super::logical_registry::{Policy, Registry, RESUME_TTL};
use super::logical_wire::{decimal, Message, Position};
use crate::{channel_auth::SessionKey, state::Shared};
use anyhow::{anyhow, bail, Result};
use genehub_proto::resume::{self, Control, Journal, Limits, Watermark};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::sync::{mpsc, oneshot, Notify, OwnedSemaphorePermit, Semaphore};

const DATA_BYTES: usize = 4 * 1024 * 1024;
const PROGRESS_BYTES: usize = 64 * 1024;
fn error(e: resume::Error) -> anyhow::Error {
    anyhow!("logical connection: {e:?}")
}

#[derive(Default)]
struct Releases {
    sequences: Mutex<Vec<u64>>,
    notify: Notify,
}
pub(crate) struct Lease {
    seq: u64,
    releases: Arc<Releases>,
}
impl Drop for Lease {
    fn drop(&mut self) {
        // At most one release per admitted receive lease. Bounded by journal
        // capacity / minimum envelope size, including zero-byte DATA frames.
        self.releases.sequences.lock().unwrap().push(self.seq);
        self.releases.notify.notify_one();
    }
}
pub(crate) struct Received {
    pub frame: Frame,
    pub lease: Lease,
}
pub(crate) struct Reader {
    incoming: mpsc::Receiver<Received>,
}
impl Reader {
    pub async fn receive(&mut self) -> Option<Received> {
        self.incoming.recv().await
    }
}
struct Write {
    frame: Frame,
    complete: oneshot::Sender<Result<()>>,
    _permit: OwnedSemaphorePermit,
}
#[derive(Clone)]
pub(crate) struct Writer {
    outgoing: mpsc::Sender<Write>,
    budget: Arc<Semaphore>,
    progress: Arc<Semaphore>,
}
impl Writer {
    pub async fn send(&mut self, frame: Frame) -> Result<()> {
        let size = frame.payload.len() + resume::HEADER_BYTES;
        if size > 16 * 1024 {
            bail!("logical write too large");
        }
        let budget = if frame.kind as u8 >= 4 {
            &self.progress
        } else {
            &self.budget
        };
        let permit = budget.clone().acquire_many_owned(size as u32).await?;
        let (complete, done) = oneshot::channel();
        self.outgoing
            .send(Write {
                frame,
                complete,
                _permit: permit,
            })
            .await
            .map_err(|_| anyhow!("logical writer closed"))?;
        done.await.map_err(|_| anyhow!("logical writer closed"))?
    }
}
struct Attachment {
    path: resume::Path,
    reader: AuthenticatedReader,
    writer: AuthenticatedWriter,
    attempt: String,
    expected: u64,
    position: Watermark,
    closed: oneshot::Sender<()>,
}
#[derive(Clone)]
pub(crate) struct Handle {
    attach: mpsc::Sender<Attachment>,
}
struct Channel {
    reader: AuthenticatedReader,
    outgoing: mpsc::Sender<Vec<u8>>,
    task: tokio::task::JoinHandle<()>,
    _closed: oneshot::Sender<()>,
    synced: bool,
    last_receive: Instant,
}
impl Drop for Channel {
    fn drop(&mut self) {
        self.task.abort();
    }
}
pub(crate) type Redial = Arc<
    dyn Fn() -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<(SessionKey, Carrier, Box<dyn Send>)>>
                    + Send,
            >,
        > + Send
        + Sync,
>;
struct Lifetime {
    registry: Option<Arc<Registry>>,
    id: String,
    business: Option<tokio::task::JoinHandle<Result<()>>>,
    recovery: Option<tokio::task::JoinHandle<()>>,
    position: Option<Arc<Mutex<Watermark>>>,
}
impl Drop for Lifetime {
    fn drop(&mut self) {
        if let Some(task) = &self.recovery {
            task.abort();
        }
        if let Some(task) = &self.business {
            task.abort();
        }
        if let Some(registry) = &self.registry {
            registry.remove(&self.id);
        }
    }
}

/// Called by a physical transport only after its normal mutual authentication.
/// Aborting this future cannot abort the separately owned logical peer task.
pub(crate) async fn serve(
    state: Shared,
    key: SessionKey,
    access: PeerAccess,
    carrier: Carrier,
    kind: CarrierKind,
) -> Result<()> {
    let (mut reader, mut writer) = authenticated_channel(key.clone(), carrier, Role::Server);
    let path = match kind {
        CarrierKind::Rtc => resume::Path::Rtc,
        CarrierKind::WebSocket if access.transport == genehub_proto::TransportKind::Loopback => {
            resume::Path::Loopback
        }
        _ => resume::Path::Fabric,
    };
    let mut created_id = None;
    let admission: Result<_> = async {
        let first = read_control(&mut reader).await?;
        let request = if let Message::Create { policy, resumable } = first {
            let policy = match policy.as_str() {
                "relay-allowed" => Policy::RelayAllowed,
                "direct-only" => Policy::DirectOnly,
                _ => bail!("invalid logical policy"),
            };
            let created = state.logical_connections.create(
                &key,
                &access,
                kind,
                policy,
                resumable,
                Instant::now(),
            )?;
            let id = created.id.clone();
            created_id = Some(id.clone());
            let registry = state.logical_connections.clone();
            let (handle, task) = start(state.clone(), access.clone(), kind, policy, id.clone());
            registry.own_task(&id, task.abort_handle(), handle)?;
            writer
                .send(
                    &Message::Created {
                        id,
                        incarnation: created.incarnation,
                        secret: created.secret,
                    }
                    .encode()?,
                )
                .await?;
            read_control(&mut reader).await?
        } else {
            first
        };
        let Message::Attach {
            id,
            incarnation,
            attempt,
            proof,
        } = request
        else {
            bail!("expected logical ATTACH");
        };
        let (epoch, server_proof) = state.logical_connections.attach(
            &id,
            &incarnation,
            &key,
            &access,
            kind,
            &attempt,
            &proof,
            Instant::now(),
        )?;
        writer
            .send(
                &Message::Attached {
                    epoch: epoch.to_string(),
                    proof: server_proof,
                }
                .encode()?,
            )
            .await?;
        let Message::Activate {
            attempt: activation_attempt,
            expected,
            position,
        } = read_control(&mut reader).await?
        else {
            bail!("expected logical ACTIVATE");
        };
        if activation_attempt != attempt || decimal(&expected)? != epoch {
            bail!("logical activation mismatch");
        }
        let handle = state.logical_connections.handle(&id)?;
        Ok((handle, attempt, epoch, position.watermark()?))
    }
    .await;
    let (handle, attempt, epoch, position) = match admission {
        Ok(admission) => admission,
        Err(error) => {
            if let Some(id) = created_id {
                state.logical_connections.remove(&id);
            }
            let message = error.to_string();
            let code = if message == "SessionLost" {
                "SessionLost"
            } else if message == "PolicyDenied" {
                "PolicyDenied"
            } else if message.contains("admission exhausted") {
                "ResourceExhausted"
            } else {
                "AdmissionRejected"
            };
            let _ = writer
                .send(&Message::Error { code: code.into() }.encode()?)
                .await;
            // Keep the authenticated reader alive until the peer acknowledges
            // termination (or a bounded deadline), so transport teardown cannot
            // fence decryption of the explicit error into a generic disconnect.
            let _ = tokio::time::timeout(std::time::Duration::from_secs(1), reader.receive()).await;
            return Err(error);
        }
    };
    let (closed, done) = oneshot::channel();
    handle
        .attach
        .send(Attachment {
            path,
            reader,
            writer,
            attempt,
            expected: epoch,
            position,
            closed,
        })
        .await
        .map_err(|_| anyhow!("SessionLost"))?;
    let _ = done.await;
    Ok(())
}
async fn read_control(reader: &mut AuthenticatedReader) -> Result<Message> {
    let bytes = tokio::time::timeout(std::time::Duration::from_secs(10), reader.receive())
        .await??
        .ok_or_else(|| anyhow!("channel closed during logical admission"))?;
    Message::decode(&bytes)
}
fn start(
    state: Shared,
    access: PeerAccess,
    kind: CarrierKind,
    policy: Policy,
    id: String,
) -> (Handle, tokio::task::JoinHandle<()>) {
    let (attach, attachments) = mpsc::channel(4);
    let (outgoing, writes) = mpsc::channel(256);
    let (deliver, incoming) = mpsc::channel(8192);
    let writer = Writer {
        outgoing,
        budget: Arc::new(Semaphore::new(DATA_BYTES)),
        progress: Arc::new(Semaphore::new(PROGRESS_BYTES)),
    };
    let registry = state.logical_connections.clone();
    let mut access = access;
    access.direct_only = policy == Policy::DirectOnly;
    access.logical_id = Some(id.clone());
    let task = tokio::spawn(async move {
        let business = tokio::spawn(super::endpoint::serve_logical(
            state,
            access,
            Reader { incoming },
            writer,
            kind,
        ));
        let lifetime = Lifetime {
            registry: Some(registry),
            id,
            business: Some(business),
            recovery: None,
            position: None,
        };
        if let Err(error) = run(&lifetime, kind, policy, attachments, writes, deliver).await {
            tracing::debug!(%error, "logical connection ended");
        }
    });
    (Handle { attach }, task)
}
async fn run(
    lifetime: &Lifetime,
    _kind: CarrierKind,
    policy: Policy,
    mut attachments: mpsc::Receiver<Attachment>,
    mut writes: mpsc::Receiver<Write>,
    deliver: mpsc::Sender<Received>,
) -> Result<()> {
    let mut journal = Journal::new(
        match policy {
            Policy::RelayAllowed => resume::Policy::RelayAllowed,
            Policy::DirectOnly => resume::Policy::DirectOnly,
        },
        Limits {
            data_bytes: DATA_BYTES,
            progress_bytes: PROGRESS_BYTES,
        },
        RESUME_TTL.as_millis() as u64,
    )
    .map_err(error)?;
    let releases = Arc::new(Releases::default());
    let start = Instant::now();
    let now = || start.elapsed().as_millis() as u64;
    let mut channel: Option<Channel> = None;
    let mut epoch = 0;
    let mut ack = false;
    // Keep one bounded reply outside the data queue; a full carrier is backpressure, not a protocol failure.
    let mut pending_pong: Option<String> = None;
    let mut terminals = std::collections::BTreeMap::<u64, oneshot::Sender<Result<()>>>::new();
    let mut budget = false;
    let mut last_ping = Instant::now();
    let mut pending = std::collections::VecDeque::<Write>::new();
    let mut clock = tokio::time::interval(std::time::Duration::from_millis(100));
    loop {
        if lifetime
            .business
            .as_ref()
            .is_some_and(|task| task.is_finished())
            || deliver.is_closed()
        {
            if let Some(active) = &channel {
                let _ = active.outgoing.try_send(Message::Close.encode()?);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            return Ok(());
        }
        if let Some(registry) = &lifetime.registry {
            registry.reap(Instant::now());
        }
        if epoch == 0 && start.elapsed() >= RESUME_TTL {
            bail!("ResumeExpired");
        }
        journal.tick(now()).map_err(error)?;
        for seq in releases.sequences.lock().unwrap().drain(..) {
            journal.release(seq).map_err(error)?;
            budget = true;
        }
        let mut blocked_streams = std::collections::HashSet::new();
        for _ in 0..pending.len() {
            let write = pending.pop_front().unwrap();
            if blocked_streams.contains(&write.frame.stream_id) {
                pending.push_back(write);
                continue;
            }
            let frame = resume::Frame {
                kind: write.frame.kind as u8,
                stream_id: write.frame.stream_id,
                value: write.frame.value,
                payload: write.frame.payload.clone(),
            };
            match journal.enqueue(frame) {
                Ok(seq) => {
                    if matches!(write.frame.kind, Kind::Fin | Kind::Reset) {
                        terminals.insert(seq, write.complete);
                    } else {
                        let _ = write.complete.send(Ok(()));
                    }
                }
                Err(resume::Error::Backpressure) => {
                    blocked_streams.insert(write.frame.stream_id);
                    pending.push_back(write);
                }
                Err(e) => {
                    let _ = write.complete.send(Err(error(e)));
                    return Err(error(e));
                }
            }
        }
        let mut pump_blocked = false;
        if let Some(active) = channel.as_ref().filter(|c| c.synced) {
            // Try-reserve before consuming a replay cursor. Control traffic has
            // priority and is coalesced, so a full DATA log cannot starve ACKs.
            loop {
                let permit = match active.outgoing.try_reserve() {
                    Ok(permit) => permit,
                    Err(_) => {
                        pump_blocked = true;
                        break;
                    }
                };
                let watermark = journal.watermark().map_err(error)?;
                let bytes = if let Some(nonce) = pending_pong.take() {
                    Some(Message::Pong { nonce }.encode()?)
                } else if ack {
                    ack = false;
                    Some(
                        Control::Ack {
                            epoch,
                            received: watermark.received,
                        }
                        .encode()
                        .map_err(error)?,
                    )
                } else if budget {
                    budget = false;
                    Some(
                        Control::Budget {
                            epoch,
                            data_grant: watermark.data_grant,
                            progress_grant: watermark.progress_grant,
                        }
                        .encode()
                        .map_err(error)?,
                    )
                } else {
                    journal.next_record().map_err(error)?
                };
                let Some(bytes) = bytes else {
                    break;
                };
                permit.send(bytes);
            }
        }
        if let Some(position) = &lifetime.position {
            *position.lock().unwrap() = journal.watermark().map_err(error)?;
        }
        let writable = channel
            .as_ref()
            .filter(|_| pump_blocked)
            .map(|c| c.outgoing.clone());
        tokio::select! {
            attachment = attachments.recv() => {
                let Some(mut attachment) = attachment else { return Ok(()); };
                // The actor alone commits admission and journal positions. An
                // invalid peer watermark must not displace a healthy channel.
                let next = attachment.expected.checked_add(1).ok_or_else(|| anyhow!("epoch exhausted"))?;
                if (lifetime.registry.is_some() && attachment.expected != epoch) || attachment.expected < epoch { continue; }
                if journal.activate(attachment.path, next, attachment.position, now()).is_err() { continue; }
                acknowledge_terminals(&mut terminals, attachment.position.received);
                epoch = if let Some(registry) = &lifetime.registry { registry.activate(&lifetime.id, &attachment.attempt, attachment.expected, Instant::now())? } else { next };
                channel.take();
                let position = Position::from_watermark(journal.watermark().map_err(error)?);
                if lifetime.registry.is_some() && attachment.writer.send(&Message::Activated { epoch: epoch.to_string(), position }.encode()?).await.is_err() {
                    journal.suspend(now()).map_err(error)?;
                    if let Some(registry) = &lifetime.registry { registry.suspend(&lifetime.id, epoch, Instant::now()); }
                    continue;
                }
                let (outgoing, mut records) = mpsc::channel::<Vec<u8>>(16);
                let task = tokio::spawn(async move { while let Some(bytes) = records.recv().await { if attachment.writer.send(&bytes).await.is_err() { break; } } });
                channel = Some(Channel { reader: attachment.reader, outgoing, task, _closed: attachment.closed, synced: lifetime.registry.is_none(), last_receive: Instant::now() });
                pending_pong = None;
                ack = true; budget = true;
            }
            incoming = async { match channel.as_mut() { Some(c) => c.reader.receive().await, None => std::future::pending().await } } => {
                let bytes = match incoming {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => { channel.take(); journal.suspend(now()).map_err(error)?; if let Some(registry) = &lifetime.registry { registry.suspend(&lifetime.id, epoch, Instant::now()); } continue; }
                    // Authentication/protocol failures are terminal; an attacker
                    // cannot turn a malformed record into endless recovery.
                    Err(e) => return Err(e),
                };
                let active = channel.as_mut().unwrap();
                active.last_receive = Instant::now();
                if bytes.get(1) == Some(&16) {
                    match Message::decode(&bytes)? {
                        Message::Sync { epoch: peer_epoch } if decimal(&peer_epoch)? == epoch && !active.synced => {
                            active.outgoing.try_send(Message::Synced { epoch: epoch.to_string() }.encode()?).map_err(|_| anyhow!("logical control queue full"))?;
                            if let Some(registry) = &lifetime.registry { registry.synced(&lifetime.id, epoch)?; }
                            active.synced = true;
                        }
                        Message::Close => return Ok(()),
                        Message::Ping { nonce } if nonce.len() <= 32 => { pending_pong = Some(nonce); }
                        Message::Pong { .. } => {}
                        _ => bail!("invalid logical transition"),
                    }
                } else {
                    if !active.synced { bail!("logical payload before SYNC"); }
                    if bytes.get(1) == Some(&1) {
                        if let Some((seq, frame)) = journal.receive(&bytes).map_err(error)? {
                            let frame = Frame { kind: Kind::try_from(frame.kind)?, stream_id: frame.stream_id, value: frame.value, payload: frame.payload };
                            deliver.try_send(Received { frame, lease: Lease { seq, releases: releases.clone() } }).map_err(|_| anyhow!("logical stream dispatch capacity exhausted"))?;
                        }
                        ack = true;
                    } else {
                        journal.receive_control(&bytes).map_err(error)?;
                        if let Control::Ack { epoch: received_epoch, received } = Control::decode(&bytes).map_err(error)? {
                            if received_epoch == epoch { acknowledge_terminals(&mut terminals, received); }
                        }
                    }
                }
            }
            write = writes.recv(), if pending.len() < 256 && !writes.is_closed() => {
                match write { Some(write) => pending.push_back(write), None => continue }
            }
            _ = async {
                if let Some(writable) = writable {
                    let _ = writable.reserve().await;
                } else { std::future::pending::<()>().await; }
            } => {}
            _ = releases.notify.notified() => {}
            _ = clock.tick() => {
                if last_ping.elapsed() >= std::time::Duration::from_secs(5) {
                    if let Some(active) = channel.as_ref().filter(|c| c.synced) {
                        let _ = active.outgoing.try_send(Message::Ping { nonce: super::logical_wire::nonce() }.encode()?);
                    }
                    last_ping = Instant::now();
                }
                if channel.as_ref().is_some_and(|c| c.task.is_finished() || c.last_receive.elapsed() >= std::time::Duration::from_secs(15)) {
                    channel.take(); journal.suspend(now()).map_err(error)?; if let Some(registry) = &lifetime.registry { registry.suspend(&lifetime.id, epoch, Instant::now()); }
                }
            }
        }
    }
}

/// Native clients use the same journal actor and stream engine. The public
/// Dropping the native Reader closes dispatch; the actor then releases its
/// bounded queues. Device callers may retain a bounded authenticated redial owner.
pub(crate) async fn client(
    key: SessionKey,
    carrier: Carrier,
    redial: Option<Redial>,
) -> Result<(Reader, Writer, tokio::task::JoinHandle<()>)> {
    let (mut reader, mut writer) = authenticated_channel(key.clone(), carrier, Role::Client);
    writer
        .send(
            &Message::Create {
                policy: "relay-allowed".into(),
                resumable: redial.is_some(),
            }
            .encode()?,
        )
        .await?;
    let Message::Created {
        id,
        incarnation,
        secret,
    } = read_control(&mut reader).await?
    else {
        bail!("expected CREATED");
    };
    let attempt = super::logical_wire::nonce();
    let proof = key.resume_proof(&secret, &id, &incarnation, &attempt);
    writer
        .send(
            &Message::Attach {
                id: id.clone(),
                incarnation: incarnation.clone(),
                attempt: attempt.clone(),
                proof,
            }
            .encode()?,
        )
        .await?;
    let Message::Attached { epoch, proof } = read_control(&mut reader).await? else {
        bail!("expected ATTACHED");
    };
    let expected = decimal(&epoch)?;
    crate::channel_auth::verify_proof(
        &key.resume_server_proof(&secret, &id, &incarnation, &attempt, expected),
        &proof,
    )?;
    if expected != 0 {
        bail!("new native logical peer has a nonzero epoch");
    }
    let position = Position::from_watermark(Watermark {
        received: 0,
        data_grant: DATA_BYTES as u64,
        progress_grant: PROGRESS_BYTES as u64,
    });
    writer
        .send(
            &Message::Activate {
                attempt: attempt.clone(),
                expected: epoch,
                position,
            }
            .encode()?,
        )
        .await?;
    let Message::Activated { epoch, position } = read_control(&mut reader).await? else {
        bail!("expected ACTIVATED");
    };
    if decimal(&epoch)? != 1 {
        bail!("invalid initial logical epoch");
    }
    writer
        .send(
            &Message::Sync {
                epoch: epoch.clone(),
            }
            .encode()?,
        )
        .await?;
    let Message::Synced { epoch: synced } = read_control(&mut reader).await? else {
        bail!("expected SYNCED");
    };
    if synced != epoch {
        bail!("logical SYNC mismatch");
    }
    let (attach, attachments) = mpsc::channel(4);
    let (outgoing, writes) = mpsc::channel(256);
    let (deliver, incoming) = mpsc::channel(8192);
    let (closed, mut disconnected) = oneshot::channel();
    let local_position = Arc::new(Mutex::new(Watermark {
        received: 0,
        data_grant: DATA_BYTES as u64,
        progress_grant: PROGRESS_BYTES as u64,
    }));
    let recovery = redial.map(|redial| {
        let attach = attach.clone();
        let local_position = local_position.clone();
        tokio::spawn(async move {
            let mut pump: Option<Box<dyn Send>> = None;
            loop {
                let _ = disconnected.await;
                drop(pump.take());
                let deadline = tokio::time::Instant::now() + RESUME_TTL;
                loop {
                    if attach.is_closed() {
                        return;
                    }
                    let position = *local_position.lock().unwrap();
                    let recovered = tokio::time::timeout_at(deadline, async {
                        let (key, carrier, pump) = redial().await?;
                        let (reader, writer) =
                            authenticated_channel(key.clone(), carrier, Role::Client);
                        let attachment = resume_client(
                            &key,
                            reader,
                            writer,
                            &id,
                            &incarnation,
                            &secret,
                            position,
                        )
                        .await?;
                        Ok::<_, anyhow::Error>((attachment, pump))
                    })
                    .await;
                    if let Ok(Ok((mut attachment, next_pump))) = recovered {
                        let (closed, next_disconnected) = oneshot::channel();
                        attachment.closed = closed;
                        if attach.send(attachment).await.is_err() {
                            return;
                        }
                        pump = Some(next_pump);
                        disconnected = next_disconnected;
                        break;
                    }
                    if tokio::time::Instant::now() >= deadline {
                        return;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
            }
        })
    });
    attach
        .try_send(Attachment {
            path: resume::Path::Loopback,
            reader,
            writer,
            attempt,
            expected,
            position: position.watermark()?,
            closed,
        })
        .map_err(|_| anyhow!("logical attach queue full"))?;
    let task = tokio::spawn(async move {
        let _keep_attachments = attach;
        let lifetime = Lifetime {
            registry: None,
            id: String::new(),
            business: None,
            recovery,
            position: Some(local_position),
        };
        if let Err(error) = run(
            &lifetime,
            CarrierKind::WebSocket,
            Policy::RelayAllowed,
            attachments,
            writes,
            deliver,
        )
        .await
        {
            tracing::debug!(%error, "native logical connection ended");
        }
    });
    Ok((
        Reader { incoming },
        Writer {
            outgoing,
            budget: Arc::new(Semaphore::new(DATA_BYTES)),
            progress: Arc::new(Semaphore::new(PROGRESS_BYTES)),
        },
        task,
    ))
}

async fn resume_client(
    key: &SessionKey,
    mut reader: AuthenticatedReader,
    mut writer: AuthenticatedWriter,
    id: &str,
    incarnation: &str,
    secret: &str,
    position: Watermark,
) -> Result<Attachment> {
    let attempt = super::logical_wire::nonce();
    writer
        .send(
            &Message::Attach {
                id: id.into(),
                incarnation: incarnation.into(),
                attempt: attempt.clone(),
                proof: key.resume_proof(secret, id, incarnation, &attempt),
            }
            .encode()?,
        )
        .await?;
    let Message::Attached { epoch, proof } = read_control(&mut reader).await? else {
        bail!("resume admission rejected");
    };
    let expected = decimal(&epoch)?;
    crate::channel_auth::verify_proof(
        &key.resume_server_proof(secret, id, incarnation, &attempt, expected),
        &proof,
    )?;
    writer
        .send(
            &Message::Activate {
                attempt: attempt.clone(),
                expected: epoch,
                position: Position::from_watermark(position),
            }
            .encode()?,
        )
        .await?;
    let Message::Activated { epoch, position } = read_control(&mut reader).await? else {
        bail!("resume activation rejected");
    };
    if decimal(&epoch)?
        != expected
            .checked_add(1)
            .ok_or_else(|| anyhow!("epoch exhausted"))?
    {
        bail!("invalid resumed epoch");
    }
    writer
        .send(
            &Message::Sync {
                epoch: epoch.clone(),
            }
            .encode()?,
        )
        .await?;
    let Message::Synced { epoch: synced } = read_control(&mut reader).await? else {
        bail!("resume sync rejected");
    };
    if synced != epoch {
        bail!("resume SYNC mismatch");
    }
    let (closed, _) = oneshot::channel();
    Ok(Attachment {
        path: resume::Path::Loopback,
        reader,
        writer,
        attempt,
        expected,
        position: position.watermark()?,
        closed,
    })
}

fn acknowledge_terminals(
    terminals: &mut std::collections::BTreeMap<u64, oneshot::Sender<Result<()>>>,
    received: u64,
) {
    while terminals
        .first_key_value()
        .is_some_and(|(seq, _)| *seq <= received)
    {
        if let Some((_, complete)) = terminals.pop_first() {
            let _ = complete.send(Ok(()));
        }
    }
}
