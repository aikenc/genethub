//! Carrier-neutral client half of the v3 data plane.
//!
//! The browser has the equivalent implementation in `packages/workbench`.  This
//! small Rust half keeps CLI and integration clients on the exact same binary
//! frame, flow-control and E2EE contract as every other peer.

use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{ExchangeRequestHead, ExchangeResponseHead};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};

use crate::channel_auth::{self, Direction, SessionKey};
use crate::dataplane::endpoint::Carrier;
use crate::dataplane::frame::{Frame, Kind, MAX_PAYLOAD_BYTES};

const COMMAND_QUEUE: usize = 256;
const STREAM_QUEUE: usize = 32;
const MAX_REQUEST_BODY_BYTES: usize = 3 * 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BODY_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug)]
pub struct ExchangeResponse {
    pub head: ExchangeResponseHead,
    pub body: Vec<u8>,
}

struct Call {
    head: ExchangeRequestHead,
    body: Vec<u8>,
    maximum_response_bytes: usize,
    target: ResponseTarget,
}

enum ResponseTarget {
    Unary(Option<oneshot::Sender<Result<ExchangeResponse>>>),
    Streaming {
        head: Option<oneshot::Sender<Result<ExchangeResponseHead>>>,
        chunks: mpsc::Sender<Result<Vec<u8>>>,
    },
}

struct Stream {
    request: Vec<u8>,
    request_offset: usize,
    local_sequence: u32,
    outbound_credit: u32,
    local_finished: bool,
    response_head: Option<ExchangeResponseHead>,
    response: Vec<u8>,
    received_response_bytes: usize,
    maximum_response_bytes: usize,
    remote_sequence: u32,
    target: ResponseTarget,
}

/// Opens independent odd-numbered logical streams on one authenticated peer
/// carrier. Clones share the endpoint but never share a business stream.
#[derive(Clone)]
pub struct ClientEndpoint {
    commands: mpsc::Sender<Call>,
}

pub struct ClientStream {
    head: oneshot::Receiver<Result<ExchangeResponseHead>>,
    chunks: mpsc::Receiver<Result<Vec<u8>>>,
}

impl ClientStream {
    pub async fn response_head(&mut self) -> Result<ExchangeResponseHead> {
        (&mut self.head)
            .await
            .map_err(|_| anyhow!("the data endpoint closed before the response head"))?
    }

    pub async fn next_chunk(&mut self) -> Option<Result<Vec<u8>>> {
        self.chunks.recv().await
    }
}

impl ClientEndpoint {
    pub fn start(key: SessionKey, carrier: Carrier) -> (Self, tokio::task::JoinHandle<Result<()>>) {
        let (commands, receiver) = mpsc::channel(COMMAND_QUEUE);
        let task = tokio::spawn(run(key, carrier, receiver));
        (Self { commands }, task)
    }

    pub async fn exchange(
        &self,
        method: impl Into<String>,
        metadata: Value,
        body: Vec<u8>,
        timeout_ms: Option<u32>,
    ) -> Result<ExchangeResponse> {
        self.exchange_bounded(
            method,
            metadata,
            body,
            timeout_ms,
            DEFAULT_MAX_RESPONSE_BODY_BYTES,
        )
        .await
    }

    pub async fn exchange_bounded(
        &self,
        method: impl Into<String>,
        metadata: Value,
        body: Vec<u8>,
        timeout_ms: Option<u32>,
        maximum_response_bytes: usize,
    ) -> Result<ExchangeResponse> {
        if body.len() > MAX_REQUEST_BODY_BYTES {
            anyhow::bail!("exchange request body is too large");
        }
        let method = method.into();
        if method.is_empty() || method.len() > 128 || maximum_response_bytes == 0 {
            anyhow::bail!("invalid exchange bounds");
        }
        let body_length = Some(u64::try_from(body.len())?);
        let (answer, outcome) = oneshot::channel();
        self.commands
            .send(Call {
                head: ExchangeRequestHead {
                    version: genehub_proto::DATA_PLANE_VERSION,
                    method,
                    metadata,
                    body_length,
                    timeout_ms,
                },
                body,
                maximum_response_bytes,
                target: ResponseTarget::Unary(Some(answer)),
            })
            .await
            .map_err(|_| anyhow!("the data endpoint is closed"))?;
        outcome
            .await
            .map_err(|_| anyhow!("the data endpoint closed before answering"))?
    }

    /// Opens a response stream without coupling transport progress to the
    /// caller's processing loop. Used for events and future large pull APIs.
    pub async fn open_stream(
        &self,
        method: impl Into<String>,
        metadata: Value,
        body: Vec<u8>,
        timeout_ms: Option<u32>,
    ) -> Result<ClientStream> {
        if body.len() > MAX_REQUEST_BODY_BYTES {
            anyhow::bail!("exchange request body is too large");
        }
        let method = method.into();
        if method.is_empty() || method.len() > 128 {
            anyhow::bail!("invalid exchange method");
        }
        let (head, head_receiver) = oneshot::channel();
        let (chunks, chunk_receiver) = mpsc::channel(STREAM_QUEUE);
        self.commands
            .send(Call {
                head: ExchangeRequestHead {
                    version: genehub_proto::DATA_PLANE_VERSION,
                    method,
                    metadata,
                    body_length: Some(u64::try_from(body.len())?),
                    timeout_ms,
                },
                body,
                maximum_response_bytes: usize::MAX,
                target: ResponseTarget::Streaming {
                    head: Some(head),
                    chunks,
                },
            })
            .await
            .map_err(|_| anyhow!("the data endpoint is closed"))?;
        Ok(ClientStream {
            head: head_receiver,
            chunks: chunk_receiver,
        })
    }
}

async fn run(
    key: SessionKey,
    mut carrier: Carrier,
    mut commands: mpsc::Receiver<Call>,
) -> Result<()> {
    let mut streams = HashMap::<u32, Stream>::new();
    let mut next_stream_id = 1u32;
    let mut send_sequence = 0u64;
    let mut receive_sequence = 0u64;

    let outcome = loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(mut call) = command else { break Ok(()); };
                if streams.len() >= genehub_proto::MAX_ACTIVE_DATA_STREAMS {
                    call.target.fail("too many logical streams are active");
                    continue;
                }
                let stream_id = next_stream_id;
                next_stream_id = match next_stream_id.checked_add(2) {
                    Some(next) => next,
                    None => {
                        call.target.fail("logical stream identifiers are exhausted");
                        continue;
                    }
                };
                let payload = serde_json::to_vec(&call.head)?;
                if payload.is_empty() || payload.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES {
                    call.target.fail("exchange head exceeds its bounded field");
                    continue;
                }
                streams.insert(stream_id, Stream {
                    request: call.body,
                    request_offset: 0,
                    local_sequence: 0,
                    outbound_credit: genehub_proto::INITIAL_STREAM_WINDOW_BYTES,
                    local_finished: false,
                    response_head: None,
                    response: Vec::new(),
                    received_response_bytes: 0,
                    maximum_response_bytes: call.maximum_response_bytes,
                    remote_sequence: 0,
                    target: call.target,
                });
                send(
                    &key,
                    &carrier.outbound,
                    &mut send_sequence,
                    Frame {
                        kind: Kind::Open,
                        stream_id,
                        value: genehub_proto::INITIAL_STREAM_WINDOW_BYTES,
                        payload,
                    },
                ).await?;
                pump_request(
                    &key,
                    &carrier.outbound,
                    &mut send_sequence,
                    stream_id,
                    streams.get_mut(&stream_id).expect("inserted stream"),
                ).await?;
            }
            record = carrier.inbound.recv() => {
                let Some(record) = record else { break Ok(()); };
                receive_sequence = receive_sequence.checked_add(1)
                    .ok_or_else(|| anyhow!("secure record sequence exhausted"))?;
                let plaintext = channel_auth::open_data_record(
                    &key,
                    Direction::DaemonToClient,
                    receive_sequence,
                    &record,
                )?;
                let frame = Frame::decode(&plaintext)?;
                if frame.kind == Kind::Ping {
                    send(
                        &key,
                        &carrier.outbound,
                        &mut send_sequence,
                        Frame { kind: Kind::Pong, ..frame },
                    ).await?;
                    continue;
                }
                if frame.kind == Kind::Pong {
                    continue;
                }
                let Some(mut stream) = streams.remove(&frame.stream_id) else {
                    if frame.kind != Kind::Reset {
                        send_reset(
                            &key,
                            &carrier.outbound,
                            &mut send_sequence,
                            frame.stream_id,
                            crate::dataplane::endpoint::RESET_PROTOCOL,
                        ).await?;
                    }
                    continue;
                };
                let mut keep = true;
                match frame.kind {
                    Kind::Head => {
                        if stream.response_head.is_some()
                            || frame.value == 0
                            || frame.value > genehub_proto::INITIAL_STREAM_WINDOW_BYTES
                            || frame.payload.is_empty()
                            || frame.payload.len() > genehub_proto::MAX_EXCHANGE_HEAD_BYTES
                        {
                            anyhow::bail!("invalid exchange response head");
                        }
                        let head: ExchangeResponseHead = serde_json::from_slice(&frame.payload)
                            .context("invalid exchange response head")?;
                        if head.body_length.is_some_and(|length| {
                            length > stream.maximum_response_bytes as u64
                        }) {
                            send_reset(
                                &key,
                                &carrier.outbound,
                                &mut send_sequence,
                                frame.stream_id,
                                crate::dataplane::endpoint::RESET_TOO_LARGE,
                            ).await?;
                            stream.target.fail("exchange response is too large");
                            keep = false;
                        } else {
                            stream.target.accept_head(&head);
                            stream.response_head = Some(head);
                            stream.outbound_credit = frame.value;
                        }
                    }
                    Kind::Data => {
                        let expected = stream.remote_sequence.checked_add(1)
                            .ok_or_else(|| anyhow!("stream sequence exhausted"))?;
                        let next = stream.received_response_bytes.checked_add(frame.payload.len())
                            .ok_or_else(|| anyhow!("response length overflow"))?;
                        if frame.value != expected || frame.payload.is_empty()
                            || stream.response_head.is_none()
                            || next > stream.maximum_response_bytes
                        {
                            anyhow::bail!("invalid exchange response data");
                        }
                        stream.remote_sequence = expected;
                        stream.received_response_bytes = next;
                        let credit = u32::try_from(frame.payload.len())?;
                        if !stream.target.push(&frame.payload) {
                            send_reset(
                                &key,
                                &carrier.outbound,
                                &mut send_sequence,
                                frame.stream_id,
                                crate::dataplane::endpoint::RESET_CANCELLED,
                            ).await?;
                            keep = false;
                        } else if stream.target.is_unary() {
                            stream.response.extend_from_slice(&frame.payload);
                        }
                        if keep {
                            send(
                                &key,
                                &carrier.outbound,
                                &mut send_sequence,
                                Frame {
                                    kind: Kind::WindowUpdate,
                                    stream_id: frame.stream_id,
                                    value: credit,
                                    payload: Vec::new(),
                                },
                            ).await?;
                        }
                    }
                    Kind::WindowUpdate => {
                        let Some(next) = stream.outbound_credit.checked_add(frame.value) else {
                            anyhow::bail!("invalid stream credit");
                        };
                        if !frame.payload.is_empty() || frame.value == 0
                            || next > genehub_proto::INITIAL_STREAM_WINDOW_BYTES
                        {
                            anyhow::bail!("invalid stream credit");
                        }
                        stream.outbound_credit = next;
                    }
                    Kind::Fin => {
                        if frame.value != 0 || !frame.payload.is_empty() || stream.response_head.is_none() {
                            anyhow::bail!("invalid exchange response FIN");
                        }
                        let head = stream.response_head.take().unwrap();
                        if head.body_length.is_some_and(|length| length != stream.received_response_bytes as u64) {
                            anyhow::bail!("exchange response length does not match its head");
                        }
                        let body = std::mem::take(&mut stream.response);
                        stream.target.finish(head, body);
                        keep = false;
                    }
                    Kind::Reset => {
                        if frame.value == 0 || !frame.payload.is_empty() {
                            anyhow::bail!("invalid logical stream reset");
                        }
                        stream.target.fail(format!("logical stream was reset ({})", frame.value));
                        keep = false;
                    }
                    Kind::Open | Kind::Ping | Kind::Pong => {
                        anyhow::bail!("invalid daemon-to-client stream transition");
                    }
                }
                if keep {
                    pump_request(
                        &key,
                        &carrier.outbound,
                        &mut send_sequence,
                        frame.stream_id,
                        &mut stream,
                    ).await?;
                    streams.insert(frame.stream_id, stream);
                }
            }
        }
    };

    let message = outcome
        .as_ref()
        .err()
        .map(|error| format!("data endpoint stopped: {error:#}"))
        .unwrap_or_else(|| "the data endpoint closed".into());
    for (_, mut stream) in streams {
        stream.target.fail(message.clone());
    }
    outcome
}

impl ResponseTarget {
    fn is_unary(&self) -> bool {
        matches!(self, Self::Unary(_))
    }

    fn accept_head(&mut self, head: &ExchangeResponseHead) {
        if let Self::Streaming { head: sender, .. } = self {
            if let Some(sender) = sender.take() {
                let _ = sender.send(Ok(head.clone()));
            }
        }
    }

    fn push(&self, bytes: &[u8]) -> bool {
        match self {
            Self::Unary(_) => true,
            Self::Streaming { chunks, .. } => chunks.try_send(Ok(bytes.to_vec())).is_ok(),
        }
    }

    fn finish(&mut self, head: ExchangeResponseHead, body: Vec<u8>) {
        match self {
            Self::Unary(answer) => {
                if let Some(answer) = answer.take() {
                    let _ = answer.send(Ok(ExchangeResponse { head, body }));
                }
            }
            Self::Streaming { .. } => {}
        }
    }

    fn fail(&mut self, message: impl Into<String>) {
        let message = message.into();
        match self {
            Self::Unary(answer) => {
                if let Some(answer) = answer.take() {
                    let _ = answer.send(Err(anyhow!(message)));
                }
            }
            Self::Streaming { head, chunks } => {
                if let Some(head) = head.take() {
                    let _ = head.send(Err(anyhow!(message.clone())));
                } else {
                    let _ = chunks.try_send(Err(anyhow!(message)));
                }
            }
        }
    }
}

async fn pump_request(
    key: &SessionKey,
    outbound: &mpsc::Sender<Vec<u8>>,
    send_sequence: &mut u64,
    stream_id: u32,
    stream: &mut Stream,
) -> Result<()> {
    while stream.request_offset < stream.request.len() && stream.outbound_credit > 0 {
        let length = (stream.request.len() - stream.request_offset)
            .min(stream.outbound_credit as usize)
            .min(MAX_PAYLOAD_BYTES);
        stream.local_sequence = stream
            .local_sequence
            .checked_add(1)
            .ok_or_else(|| anyhow!("stream sequence exhausted"))?;
        send(
            key,
            outbound,
            send_sequence,
            Frame {
                kind: Kind::Data,
                stream_id,
                value: stream.local_sequence,
                payload: stream.request[stream.request_offset..stream.request_offset + length]
                    .to_vec(),
            },
        )
        .await?;
        stream.request_offset += length;
        stream.outbound_credit -= length as u32;
    }
    if stream.request_offset == stream.request.len() && !stream.local_finished {
        stream.local_finished = true;
        send(
            key,
            outbound,
            send_sequence,
            Frame {
                kind: Kind::Fin,
                stream_id,
                value: 0,
                payload: Vec::new(),
            },
        )
        .await?;
    }
    Ok(())
}

async fn send_reset(
    key: &SessionKey,
    outbound: &mpsc::Sender<Vec<u8>>,
    send_sequence: &mut u64,
    stream_id: u32,
    code: u32,
) -> Result<()> {
    send(
        key,
        outbound,
        send_sequence,
        Frame {
            kind: Kind::Reset,
            stream_id,
            value: code,
            payload: Vec::new(),
        },
    )
    .await
}

async fn send(
    key: &SessionKey,
    outbound: &mpsc::Sender<Vec<u8>>,
    send_sequence: &mut u64,
    frame: Frame,
) -> Result<()> {
    *send_sequence = send_sequence
        .checked_add(1)
        .ok_or_else(|| anyhow!("secure record sequence exhausted"))?;
    let plaintext = frame.encode()?;
    let record =
        channel_auth::seal_data_record(key, Direction::ClientToDaemon, *send_sequence, &plaintext)?;
    outbound
        .send(record)
        .await
        .map_err(|_| anyhow!("peer carrier closed"))
}
