//! A rendezvous relay small enough to run inside a test.
//!
//! It does what the real one does and nothing else: hold the machine's socket
//! open, and hand whoever asks for the same slot a channel onto it. It never
//! decides who may talk to the machine, which is the whole point — a relay that
//! could decide is a relay that could be persuaded (`docs/security-model.md`
//! §4.2). Running one here means the admission tests exercise the real
//! forwarded path, mux framing included, rather than a stand-in for it.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Result;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};

const KIND_OPEN: u8 = 1;
const KIND_TEXT: u8 = 2;
const KIND_CLOSE: u8 = 4;
const HEADER_BYTES: usize = 17;

pub struct FakeRelay {
    pub url: String,
    slots: Slots,
    handle: tokio::task::JoinHandle<()>,
}

/// One machine waiting at a slot: how to reach it, and who is on its channels.
struct Slot {
    to_machine: mpsc::UnboundedSender<Vec<u8>>,
    clients: HashMap<String, mpsc::UnboundedSender<String>>,
}

type Slots = Arc<Mutex<HashMap<String, Slot>>>;

impl FakeRelay {
    pub async fn start() -> Result<Self> {
        let slots: Slots = Arc::new(Mutex::new(HashMap::new()));
        let app = Router::new()
            .route("/forward/daemon", get(machine_arrives))
            .route("/forward/client", get(client_arrives))
            .with_state(slots.clone());

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let port = listener.local_addr()?.port();
        let handle = tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });

        Ok(FakeRelay {
            url: format!("http://127.0.0.1:{port}"),
            slots,
            handle,
        })
    }

    /// Whether a machine is currently waiting to be found.
    pub async fn has_machine(&self) -> bool {
        !self.slots.lock().await.is_empty()
    }

    pub fn shutdown(self) {
        self.handle.abort();
    }
}

/// The machine's ticket is `token.rendezvous` or just `rendezvous`; the relay
/// only cares about the part that says which slot to hold.
async fn machine_arrives(
    State(slots): State<Slots>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let ticket = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_string();
    let id = ticket.rsplit('.').next().unwrap_or_default().to_string();
    upgrade.on_upgrade(move |socket| hold_slot(slots, id, socket))
}

async fn hold_slot(slots: Slots, id: String, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (to_machine, mut outbound) = mpsc::unbounded_channel::<Vec<u8>>();
    slots.lock().await.insert(
        id.clone(),
        Slot {
            to_machine,
            clients: HashMap::new(),
        },
    );

    let writer = tokio::spawn(async move {
        while let Some(frame) = outbound.recv().await {
            if sink.send(Message::Binary(frame.into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(message)) = stream.next().await {
        let Message::Binary(data) = message else {
            continue;
        };
        if data.len() < HEADER_BYTES {
            continue;
        }
        let channel = hex(&data[1..HEADER_BYTES]);
        let text = String::from_utf8_lossy(&data[HEADER_BYTES..]).into_owned();
        let mut held = slots.lock().await;
        let Some(slot) = held.get_mut(&id) else { break };
        match data[0] {
            KIND_TEXT => {
                if let Some(client) = slot.clients.get(&channel) {
                    let _ = client.send(text);
                }
            }
            KIND_CLOSE => {
                slot.clients.remove(&channel);
            }
            _ => {}
        }
    }

    writer.abort();
    slots.lock().await.remove(&id);
}

#[derive(serde::Deserialize)]
struct Ticket {
    ticket: String,
}

async fn client_arrives(
    State(slots): State<Slots>,
    Query(query): Query<Ticket>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| bridge(slots, query.ticket, socket))
}

async fn bridge(slots: Slots, id: String, socket: WebSocket) {
    let channel = uuid::Uuid::new_v4().simple().to_string();
    let (from_machine_tx, mut from_machine) = mpsc::unbounded_channel::<String>();

    let to_machine = {
        let mut held = slots.lock().await;
        // Nobody home. Closing beats hanging: the client is told to stop
        // waiting, which is what a link to a machine that is off should do.
        let Some(slot) = held.get_mut(&id) else {
            return;
        };
        slot.clients.insert(channel.clone(), from_machine_tx);
        let _ = slot.to_machine.send(frame(KIND_OPEN, &channel, b""));
        slot.to_machine.clone()
    };

    let (mut sink, mut stream) = socket.split();
    let writer = tokio::spawn(async move {
        while let Some(text) = from_machine.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
        // The machine hung up on this channel, so the client's socket goes with
        // it — the real relay does the same, and a client left waiting cannot
        // tell a refusal from a stall.
        let _ = sink.close().await;
    });

    while let Some(Ok(message)) = stream.next().await {
        if let Message::Text(text) = message {
            if to_machine
                .send(frame(KIND_TEXT, &channel, text.as_bytes()))
                .is_err()
            {
                break;
            }
        }
    }

    let _ = to_machine.send(frame(KIND_CLOSE, &channel, b""));
    if let Some(slot) = slots.lock().await.get_mut(&id) {
        slot.clients.remove(&channel);
    }
    writer.abort();
}

fn frame(kind: u8, channel: &str, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_BYTES + payload.len());
    out.push(kind);
    for index in 0..16 {
        let at = index * 2;
        out.push(
            channel
                .get(at..at + 2)
                .and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .unwrap_or(0),
        );
    }
    out.extend_from_slice(payload);
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
