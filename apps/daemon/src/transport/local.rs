//! The loopback and LAN listener: HTTP for health, WebSocket for the protocol.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{
    parse_envelope, ErrorCode, NoticeLevel, SequencedEvent, ServerFrame,
};
use tokio::sync::{broadcast, mpsc};

use super::auth;
use crate::pty::PtyMessage;
use crate::router::{self, SideEffect};
use crate::state::Shared;

pub struct Listener {
    pub port: u16,
    pub handle: tokio::task::JoinHandle<()>,
}

/// Fans PTY output out to every connected client.
///
/// A terminal is shared across a user's devices on purpose: picking up a
/// running command on your phone is the point of the product.
type PtyFanout = broadcast::Sender<ServerFrame>;

pub async fn serve(
    state: Shared,
    mut pty_rx: mpsc::UnboundedReceiver<PtyMessage>,
) -> Result<Listener> {
    let (config_port, lan_enabled) = {
        let config = state.config.read().await;
        (config.port, config.lan_enabled)
    };

    let bind: IpAddr = if lan_enabled {
        // Listening beyond loopback is opt-in; see `docs/daemon.md` §6.
        "0.0.0.0".parse().unwrap()
    } else {
        "127.0.0.1".parse().unwrap()
    };

    let (pty_tx, _) = broadcast::channel::<ServerFrame>(1024);
    let fanout = pty_tx.clone();
    tokio::spawn(async move {
        while let Some(message) = pty_rx.recv().await {
            let frame = match message {
                PtyMessage::Output { pty_id, data } => ServerFrame::PtyOutput { pty_id, data },
                PtyMessage::Closed { pty_id, exit_code } => {
                    ServerFrame::PtyClosed { pty_id, exit_code }
                }
            };
            let _ = fanout.send(frame);
        }
    });

    let app = Router::new()
        .route("/health", get(health))
        .route("/ws", get(upgrade))
        .with_state(Context_ {
            state: state.clone(),
            pty: pty_tx,
        });

    let listener = tokio::net::TcpListener::bind(SocketAddr::new(bind, config_port))
        .await
        .with_context(|| format!("binding {bind}:{config_port}"))?;
    let port = listener.local_addr()?.port();

    let handle = tokio::spawn(async move {
        if let Err(error) = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        {
            tracing::error!("the local listener stopped: {error}");
        }
    });

    Ok(Listener { port, handle })
}

#[derive(Clone)]
struct Context_ {
    state: Shared,
    pty: PtyFanout,
}

async fn health() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

async fn upgrade(
    State(context): State<Context_>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    let presented = auth::extract_token(
        params.get("token").map(|t| format!("token={t}")).as_deref(),
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    );

    let authorized = presented
        .as_deref()
        .is_some_and(|token| auth::token_matches(&context.state.token, token));
    if !authorized {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token").into_response();
    }

    ws.on_upgrade(move |socket| connection(socket, context, remote.ip()))
}

async fn connection(socket: WebSocket, context: Context_, remote: IpAddr) {
    let transport = router::transport_for(Some(remote));
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<ServerFrame>();

    // One writer task owns the sink, so handlers and event pumps can all send
    // without contending for it.
    let writer = tokio::spawn(async move {
        while let Some(frame) = outbound_rx.recv().await {
            let Ok(text) = serde_json::to_string(&frame) else {
                continue;
            };
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });

    // Terminal output flows to every client without an explicit subscription.
    let pty_out = outbound.clone();
    let mut pty_rx = context.pty.subscribe();
    let pty_task = tokio::spawn(async move {
        loop {
            match pty_rx.recv().await {
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

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Close(_) => break,
            // Ping and pong are handled by the transport; binary frames are not
            // part of this protocol.
            _ => continue,
        };

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

        let handled = router::handle(&context.state, transport, envelope.request).await;
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
    drop(outbound);
    let _ = writer.await;
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

/// Convenience for tests and the desktop shell.
pub fn websocket_url(port: u16, token: &str) -> String {
    format!("ws://127.0.0.1:{port}/ws?token={token}")
}

pub type SharedListener = Arc<Listener>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_websocket_url_carries_the_token_for_browser_clients() {
        assert_eq!(
            websocket_url(1234, "abc"),
            "ws://127.0.0.1:1234/ws?token=abc"
        );
    }
}
