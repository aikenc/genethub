//! The client protocol loop, with no opinion about how bytes arrive.
//!
//! A client may reach the daemon over loopback, over the LAN, or relayed
//! through the Hub. Those differ in how they are authenticated and framed and
//! in nothing else, so the loop that turns requests into replies lives here and
//! each transport supplies a pair of channels.

use std::collections::HashMap;

use genehub_proto::TransportKind;
use genehub_proto::{parse_envelope, ErrorCode, NoticeLevel, SequencedEvent, ServerFrame};
use tokio::sync::{broadcast, mpsc};

use crate::router::{self, SideEffect};
use crate::state::Shared;

/// Everything a transport has to provide.
pub struct Channels {
    /// Text frames from the client, already de-framed.
    pub inbound: mpsc::UnboundedReceiver<String>,
    /// Where replies, events and terminal output go.
    pub outbound: mpsc::UnboundedSender<ServerFrame>,
    /// Terminal output for every client on this daemon.
    pub pty: broadcast::Receiver<ServerFrame>,
}

/// Runs one client connection to completion.
pub async fn drive(state: Shared, transport: TransportKind, channels: Channels) {
    let Channels {
        mut inbound,
        outbound,
        mut pty,
    } = channels;

    let pty_out = outbound.clone();
    let pty_task = tokio::spawn(async move {
        loop {
            match pty.recv().await {
                Ok(frame) => {
                    if pty_out.send(frame).is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Closed) => break,
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
            }
        }
    });

    let mut subscriptions: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    let mut greeted = false;

    while let Some(text) = inbound.recv().await {
        let envelope = match parse_envelope(&text) {
            Ok(envelope) => envelope,
            Err((id, error)) => {
                let _ = outbound.send(ServerFrame::Result {
                    id: id.unwrap_or_else(|| "unknown".into()),
                    ok: false,
                    payload: None,
                    error: Some(error),
                });
                continue;
            }
        };

        if !greeted && router::needs_handshake(&envelope.request) {
            let _ = outbound.send(ServerFrame::err(
                envelope.id,
                ErrorCode::Unauthorized,
                "send hello before anything else",
            ));
            continue;
        }

        let handled = router::handle(&state, transport, envelope.request).await;
        let frame = match handled.reply {
            Ok(reply) => {
                greeted = true;
                ServerFrame::ok(envelope.id, reply)
            }
            Err(error) => ServerFrame::Result {
                id: envelope.id,
                ok: false,
                payload: None,
                error: Some(error),
            },
        };
        let _ = outbound.send(frame);

        match handled.effect {
            SideEffect::None => {}
            SideEffect::Subscribe {
                session_id,
                receiver,
            } => {
                // Re-subscribing replaces the old pump rather than doubling
                // every event.
                if let Some(previous) = subscriptions.remove(&session_id) {
                    previous.abort();
                }
                let sender = outbound.clone();
                let topic = session_id.clone();
                let task = tokio::spawn(forward_events(topic, receiver, sender));
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
    pty_task.abort();
}

async fn forward_events(
    session_id: String,
    mut receiver: broadcast::Receiver<SequencedEvent>,
    outbound: mpsc::UnboundedSender<ServerFrame>,
) {
    loop {
        match receiver.recv().await {
            Ok(event) => {
                if outbound
                    .send(ServerFrame::event(&session_id, event))
                    .is_err()
                {
                    break;
                }
            }
            Err(broadcast::error::RecvError::Closed) => break,
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                // Say so rather than leaving a hole: the client can resubscribe
                // with its last sequence number and get a clean answer.
                let _ = outbound.send(ServerFrame::Notice {
                    level: NoticeLevel::Warning,
                    message: format!(
                        "{missed} events were dropped for {session_id}; reconnect to resync"
                    ),
                });
            }
        }
    }
}
