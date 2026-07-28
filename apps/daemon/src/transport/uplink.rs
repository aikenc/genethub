//! The outbound connection to the Hub's forwarding layer.
//!
//! A machine at home has no public address, so it dials out and keeps one
//! socket open. Several clients may be attached at once, so that socket is
//! multiplexed: a one-byte kind and a sixteen-byte channel id in front of every
//! payload (`docs/architecture.md` §6.4). Each channel becomes an ordinary
//! client connection as far as the rest of the daemon is concerned.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{ServerFrame, TransportKind};
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use super::session;
use crate::state::Shared;

pub const KIND_OPEN: u8 = 1;
pub const KIND_TEXT: u8 = 2;
pub const KIND_BINARY: u8 = 3;
pub const KIND_CLOSE: u8 = 4;

const CHANNEL_ID_BYTES: usize = 16;
const HEADER_BYTES: usize = 1 + CHANNEL_ID_BYTES;

/// Backoff between reconnection attempts, in seconds.
const BACKOFF: [u64; 6] = [1, 2, 5, 10, 30, 60];

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
    ) -> Uplink {
        let online = Arc::new(AtomicBool::new(false));
        let task = tokio::spawn({
            let online = online.clone();
            async move {
                let mut attempt = 0usize;
                loop {
                    match run(&state, &pty, &url, &ticket, &online).await {
                        Ok(()) => {
                            tracing::info!("the uplink closed cleanly; reconnecting");
                            attempt = 0;
                        }
                        Err(error) => {
                            tracing::warn!("the uplink dropped: {error:#}");
                            attempt = (attempt + 1).min(BACKOFF.len() - 1);
                        }
                    }
                    online.store(false, Ordering::Relaxed);
                    tokio::time::sleep(Duration::from_secs(BACKOFF[attempt])).await;
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
async fn run(
    state: &Shared,
    pty: &broadcast::Sender<ServerFrame>,
    url: &str,
    ticket: &str,
    online: &AtomicBool,
) -> Result<()> {
    let mut request = url
        .into_client_request()
        .context("building the uplink request")?;
    request.headers_mut().insert(
        "authorization",
        format!("Bearer {ticket}")
            .parse()
            .context("building the uplink credential")?,
    );

    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .context("connecting to the Hub")?;
    online.store(true, Ordering::Relaxed);
    tracing::info!("uplink established");

    let (sink, mut stream) = socket.split();
    let sink = Arc::new(Mutex::new(sink));

    // Every channel's outbound frames funnel through one sender so the socket
    // has a single writer.
    let mut channels: HashMap<String, Channel> = HashMap::new();

    while let Some(message) = stream.next().await {
        let data = match message.context("reading from the Hub")? {
            Message::Binary(data) => data,
            Message::Close(_) => break,
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
                let opened = open_channel(state, pty, sink.clone(), channel.clone());
                channels.insert(channel, opened);
            }
            KIND_TEXT => {
                if let Some(open) = channels.get(&channel) {
                    let text = String::from_utf8_lossy(payload).into_owned();
                    if open.inbound.send(text).is_err() {
                        channels.remove(&channel);
                    }
                }
            }
            // The client protocol is text. A binary frame is a client bug or a
            // future feature; either way, dropping it beats guessing.
            KIND_BINARY => {}
            KIND_CLOSE => {
                if let Some(open) = channels.remove(&channel) {
                    open.task.abort();
                }
            }
            other => anyhow::bail!("the Hub sent an unknown frame kind {other}"),
        }
    }

    for (_, open) in channels {
        open.task.abort();
    }
    Ok(())
}

struct Channel {
    inbound: mpsc::UnboundedSender<String>,
    task: tokio::task::JoinHandle<()>,
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

fn open_channel(
    state: &Shared,
    pty: &broadcast::Sender<ServerFrame>,
    sink: Sink,
    channel: String,
) -> Channel {
    let (inbound, inbound_rx) = mpsc::unbounded_channel::<String>();
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<ServerFrame>();

    let writer_channel = channel.clone();
    let writer = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            let Ok(text) = serde_json::to_string(&frame) else {
                continue;
            };
            let framed = encode(KIND_TEXT, &writer_channel, text.as_bytes());
            let mut sink = sink.lock().await;
            if sink.send(Message::Binary(framed)).await.is_err() {
                break;
            }
        }
    });

    // A relayed client is authorised by the Hub, not by the daemon's local
    // token: it never had one. It still has to say hello like anyone else.
    let loop_task = tokio::spawn(session::drive(
        state.clone(),
        TransportKind::Forwarded,
        session::Channels {
            inbound: inbound_rx,
            outbound,
            pty: pty.subscribe(),
        },
    ));

    let task = tokio::spawn(async move {
        let _ = loop_task.await;
        writer.abort();
    });

    Channel { inbound, task }
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
}
