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
        .route("/shutdown", axum::routing::post(shutdown))
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

/// Ends the daemon on request from the shell that owns this machine.
///
/// Restricted to loopback on top of the token: with LAN listening on, the token
/// travels the local network, and "turn that machine off" is not a thing a
/// borrowed token should be able to do from across the room.
async fn shutdown(
    State(context): State<Context_>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    if !remote.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "shutdown is loopback only");
    }
    let presented = auth::extract_token(
        params.get("token").map(|t| format!("token={t}")).as_deref(),
        headers
            .get("authorization")
            .and_then(|value| value.to_str().ok()),
    );
    if !presented
        .as_deref()
        .is_some_and(|token| auth::token_matches(&context.state.token, token))
    {
        return (StatusCode::UNAUTHORIZED, "invalid or missing token");
    }

    // `notify_one`, not `notify_waiters`: this request can arrive before the
    // main loop has started waiting — a shell that quits or restarts right
    // after launch does exactly that — and a signal nobody was listening for
    // yet must not be dropped. Answering 202 and then staying up means the
    // shell gives up and kills us, which is the one outcome this endpoint
    // exists to avoid.
    context.state.shutdown.notify_one();
    (StatusCode::ACCEPTED, "stopping")
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

    /// The shell can ask a daemon to stop the instant it comes up — quitting
    /// or restarting right after launch does exactly that. The listener is
    /// accepting before the main loop starts waiting, so the request lands in
    /// between; if that signal is dropped the daemon answers "stopping" and
    /// then stays up, and the shell resorts to killing it with its agents
    /// still running.
    #[tokio::test]
    async fn a_stop_asked_for_before_anyone_is_waiting_still_arrives() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();

        let answer = reqwest::Client::new()
            .post(format!("http://127.0.0.1:{}/shutdown", listener.port))
            .bearer_auth(&state.token)
            .send()
            .await
            .expect("the request reaches the daemon");
        assert_eq!(answer.status(), 202);

        // Only now does the main loop begin waiting.
        tokio::time::timeout(std::time::Duration::from_secs(2), state.shutdown.notified())
            .await
            .expect("the daemon was told to stop and must still know it");

        listener.handle.abort();
    }
}
