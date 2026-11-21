//! Fabric v2 endpoint for browser TLS traffic. The native worker owns the
//! uplink and the TLS sockets, so neither passes through the WASI daemon.
use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio::task::{JoinHandle, JoinSet};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};

const HEADER: usize = 28;
const CHUNK: usize = 64 * 1024;
const MAX_STREAMS: usize = 64;
const STREAM_QUEUE: usize = 8;
const RELAY_QUEUE: usize = 32;
const IO_TIMEOUT: Duration = Duration::from_secs(8);
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const PREVIEW_HELLO: &[u8] = b"genehub-preview-tls-v1";

type StreamId = [u8; 16];
const CONTROL_ID: StreamId = [0; 16];

const INCOMING: u8 = 2;
const ACCEPT: u8 = 3;
const DATA: u8 = 4;
const FIN: u8 = 6;
const RESET: u8 = 7;
const PING: u8 = 8;
const PONG: u8 = 9;

struct Frame<'a> {
    kind: u8,
    id: StreamId,
    value: u64,
    payload: &'a [u8],
}

impl<'a> Frame<'a> {
    fn decode(bytes: &'a [u8]) -> Option<Self> {
        if bytes.len() < HEADER
            || bytes.len() > HEADER + CHUNK
            || bytes[0] != 2
            || bytes[2..4] != [0, 0]
        {
            return None;
        }
        let kind = bytes[1];
        let id = bytes[4..20].try_into().ok()?;
        if (kind == PING || kind == PONG) != (id == CONTROL_ID) {
            return None;
        }
        Some(Self {
            kind,
            id,
            value: u64::from_be_bytes(bytes[20..HEADER].try_into().ok()?),
            payload: &bytes[HEADER..],
        })
    }
}

fn frame(kind: u8, id: StreamId, value: u64, payload: &[u8]) -> Message {
    let mut bytes = Vec::with_capacity(HEADER + payload.len());
    bytes.extend_from_slice(&[2, kind, 0, 0]);
    bytes.extend_from_slice(&id);
    bytes.extend_from_slice(&value.to_be_bytes());
    bytes.extend_from_slice(payload);
    Message::Binary(bytes)
}

pub(super) async fn connect(
    url: String,
    ticket: String,
    address: SocketAddr,
) -> Result<JoinHandle<()>> {
    let uri: hyper::Uri = url.parse().context("invalid preview Relay URL")?;
    let loopback = matches!(uri.host(), Some("127.0.0.1" | "[::1]"));
    if uri
        .authority()
        .is_none_or(|authority| authority.as_str().contains('@'))
        || !(uri.scheme_str() == Some("wss") || loopback && uri.scheme_str() == Some("ws"))
        || uri.query() != Some("flow=transport-v1")
        || !uri.path().ends_with("/fabric/v2")
        || !(32..=256).contains(&ticket.len())
        || !ticket
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-.~".contains(&byte))
    {
        bail!("invalid preview Relay admission");
    }
    let mut config = WebSocketConfig::default();
    config.max_message_size = Some(HEADER + CHUNK);
    config.max_frame_size = Some(HEADER + CHUNK);
    config.write_buffer_size = CHUNK;
    config.max_write_buffer_size = 4 * CHUNK;
    let mut request = url.into_client_request()?;
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {ticket}").parse()?);
    let socket = tokio::time::timeout(
        IO_TIMEOUT,
        tokio_tungstenite::connect_async_with_config(request, Some(config), true),
    )
    .await
    .map_err(|_| anyhow::anyhow!("preview Relay handshake timed out"))?
    .map_err(|_| anyhow::anyhow!("preview Relay handshake failed"))?
    .0;
    Ok(tokio::spawn(async move {
        let _ = transfer(socket, address).await;
    }))
}

enum Input {
    Bytes(Vec<u8>),
    Fin,
}

struct Stream {
    input: mpsc::Sender<Input>,
    abort: tokio::task::AbortHandle,
    next_sequence: u64,
    finished: bool,
}

async fn transfer<S>(
    mut relay: tokio_tungstenite::WebSocketStream<S>,
    address: SocketAddr,
) -> Result<()>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut streams = HashMap::<StreamId, Stream>::new();
    let mut tasks = JoinSet::new();
    let (send, mut outgoing) = mpsc::channel(RELAY_QUEUE);
    let heartbeat = tokio::time::sleep(IDLE_TIMEOUT);
    tokio::pin!(heartbeat);
    loop {
        let reply = tokio::select! {
            _ = &mut heartbeat => break,
            Some(done) = tasks.join_next_with_id(), if !tasks.is_empty() => {
                let task_id = match done { Ok((id, ())) => id, Err(error) => error.id() };
                streams.retain(|_, stream| stream.abort.id() != task_id);
                None
            }
            message = outgoing.recv() => message,
            received = relay.next() => {
                let Some(received) = received else { break };
                heartbeat.as_mut().reset(tokio::time::Instant::now() + IDLE_TIMEOUT);
                match received? {
                    Message::Binary(bytes) => {
                        let parsed = Frame::decode(&bytes).context("invalid preview Relay frame")?;
                        dispatch(parsed, &mut streams, &mut tasks, &send, address)
                    }
                    Message::Ping(_) | Message::Pong(_) => {
                        tokio::time::timeout(IO_TIMEOUT, relay.flush()).await??;
                        None
                    }
                    Message::Close(_) => break,
                    _ => bail!("invalid preview Relay message"),
                }
            }
        };
        if let Some(reply) = reply {
            tokio::time::timeout(IO_TIMEOUT, relay.send(reply)).await??;
        }
    }
    Ok(())
}

fn dispatch(
    frame_in: Frame<'_>,
    streams: &mut HashMap<StreamId, Stream>,
    tasks: &mut JoinSet<()>,
    send: &mpsc::Sender<Message>,
    address: SocketAddr,
) -> Option<Message> {
    let Frame {
        kind,
        id,
        value,
        payload,
    } = frame_in;
    match kind {
        PING if payload.is_empty() => return Some(frame(PONG, id, value, &[])),
        INCOMING
            if !streams.contains_key(&id)
                && payload == PREVIEW_HELLO
                && streams.len() < MAX_STREAMS =>
        {
            let (input, received) = mpsc::channel(STREAM_QUEUE);
            let send = send.clone();
            let abort = tasks.spawn(async move {
                if serve_stream(id, address, received, &send).await.is_err() {
                    let _ = send.send(frame(RESET, id, 7, &[])).await;
                }
            });
            streams.insert(
                id,
                Stream {
                    input,
                    abort,
                    next_sequence: 1,
                    finished: false,
                },
            );
            return None;
        }
        RESET => {
            if let Some(stream) = streams.remove(&id) {
                stream.abort.abort();
            }
            return None;
        }
        DATA | FIN => {
            if let Some(stream) = streams.get_mut(&id) {
                if !stream.finished {
                    let input = if kind == FIN && payload.is_empty() {
                        stream.finished = true;
                        Some(Input::Fin)
                    } else if kind == DATA && value == stream.next_sequence && !payload.is_empty() {
                        stream.next_sequence += 1;
                        Some(Input::Bytes(payload.to_vec()))
                    } else {
                        None
                    };
                    if input.is_some_and(|input| stream.input.try_send(input).is_ok()) {
                        return None;
                    }
                }
            }
        }
        _ => {}
    }
    if let Some(stream) = streams.remove(&id) {
        stream.abort.abort();
    }
    (id != CONTROL_ID).then(|| frame(RESET, id, 6, &[]))
}

async fn serve_stream(
    id: StreamId,
    address: SocketAddr,
    mut received: mpsc::Receiver<Input>,
    send: &mpsc::Sender<Message>,
) -> Result<()> {
    let socket = tokio::time::timeout(IO_TIMEOUT, TcpStream::connect(address)).await??;
    socket.set_nodelay(true)?;
    let (mut reader, mut writer) = socket.into_split();
    send.send(frame(ACCEPT, id, 0, &[])).await?;
    let incoming = async {
        while let Some(input) = received.recv().await {
            match input {
                Input::Bytes(payload) => {
                    tokio::time::timeout(IO_TIMEOUT, writer.write_all(&payload)).await??
                }
                Input::Fin => break,
            }
        }
        writer.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };
    let outgoing = async {
        let mut bytes = vec![0; CHUNK];
        let mut sequence = 0;
        loop {
            let read = reader.read(&mut bytes).await?;
            if read == 0 {
                send.send(frame(FIN, id, 0, &[])).await?;
                break;
            }
            sequence += 1;
            send.send(frame(DATA, id, sequence, &bytes[..read])).await?;
        }
        Ok::<_, anyhow::Error>(())
    };
    tokio::try_join!(incoming, outgoing)?;
    Ok(())
}
