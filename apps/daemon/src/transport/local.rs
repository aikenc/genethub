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
use genehub_proto::ServerFrame;
use tokio::sync::{broadcast, mpsc};

use super::{auth, session};
use crate::pty::PtyMessage;
use crate::router;
use crate::state::Shared;

pub struct Listener {
    pub port: u16,
    pub handle: tokio::task::JoinHandle<()>,
}

/// Fans PTY output out to every connected client.
///
/// A terminal is shared across a user's devices on purpose: picking up a
/// running command on your phone is the point of the product.
pub type PtyFanout = broadcast::Sender<ServerFrame>;

/// Starts the pump that turns terminal output into client frames.
pub fn pty_fanout(mut pty_rx: mpsc::UnboundedReceiver<PtyMessage>) -> PtyFanout {
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
    pty_tx
}

pub async fn serve(state: Shared, pty_tx: PtyFanout) -> Result<Listener> {
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
    let (mut sink, mut stream) = socket.split();
    let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<ServerFrame>();
    let (inbound, inbound_rx) = mpsc::unbounded_channel::<String>();

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

    let loop_task = tokio::spawn(session::drive(
        context.state.clone(),
        router::transport_for(Some(remote)),
        session::Channels {
            inbound: inbound_rx,
            outbound,
            pty: context.pty.subscribe(),
        },
    ));

    while let Some(Ok(message)) = stream.next().await {
        match message {
            Message::Text(text) => {
                if inbound.send(text.to_string()).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            // Ping and pong are handled by the transport; binary frames are not
            // part of this protocol.
            _ => continue,
        }
    }

    drop(inbound);
    let _ = loop_task.await;
    let _ = writer.await;
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
