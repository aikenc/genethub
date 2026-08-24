//! The loopback listener: HTTP for health, WebSocket for the protocol. The
//! removed plaintext LAN configuration is retained only so startup can reject
//! it clearly; it never selects an alternate transport.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

use anyhow::{Context, Result};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::ServerFrame;
use serde::{Deserialize, Serialize};
use tokio::sync::{broadcast, mpsc};

// Minted and checked in the front door, because the other end of every one of
// these is the native `genet` binary: the two sides have to agree byte for byte
// about what a proof is, and a copy on each side is how they stop agreeing.
use genet_frontdoor::proof::{
    cli_proof, health_proof, shutdown_proof, token_matches, unix_seconds, valid_control_challenge,
    websocket_proof, websocket_server_proof, ADMISSION_LIFETIME_SECS,
};

use super::admission::Admission;
use crate::dataplane::{endpoint, handshake};
use crate::pty::PtyMessage;
use crate::router;
use crate::state::Shared;

const MAX_WS_MESSAGE_BYTES: usize = genehub_proto::MAX_DATA_FRAME_BYTES;
const WS_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const MAX_USED_CONTROL_ADMISSIONS: usize = 1024;

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
pub fn pty_fanout(mut pty_rx: mpsc::Receiver<PtyMessage>) -> PtyFanout {
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

    // This endpoint carries a machine-wide bearer and its protocol includes a
    // PTY. Serving it as `ws://` beyond loopback lets anyone who can observe a
    // LAN packet replay that bearer and execute commands as this user. Remote
    // access must use the authenticated relay path; LAN mode can return only
    // after it has a TLS/mTLS transport of its own.
    if lan_enabled {
        anyhow::bail!(
            "lanEnabled is disabled: the daemon cannot expose its privileged bearer over plaintext ws://; use Hub/Relay remote access"
        );
    }
    let bind: IpAddr = "127.0.0.1".parse().unwrap();

    // Tests can construct AppState without going through Daemon::start. Keep
    // the event source on Shared so every transport feeds the same data-plane
    // event stream.
    let _ = state.fanout.set(pty_tx);

    let app = Router::new()
        .route("/health", get(health))
        .route("/shutdown", axum::routing::post(shutdown))
        .route("/cli", axum::routing::post(cli))
        .route("/ws", get(upgrade))
        .with_state(Context_ {
            state: state.clone(),
            used_control_admissions: Arc::new(std::sync::Mutex::new(HashMap::new())),
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
    used_control_admissions: Arc<std::sync::Mutex<HashMap<String, u64>>>,
}

#[derive(Deserialize)]
struct HealthQuery {
    #[serde(default)]
    challenge: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    pid: u32,
    machine_id: String,
    fingerprint: String,
    proof: String,
}

async fn health(
    State(context): State<Context_>,
    Query(query): Query<HealthQuery>,
) -> impl IntoResponse {
    // A challenge turns this from an unauthenticated "something answered 200"
    // probe into proof that the listener owns the bearer in endpoint.json.
    // Every caller supplies a fresh challenge. An empty challenge would make a
    // captured response reusable, so even ordinary liveness probes must use
    // the authenticated form.
    if !valid_control_challenge(&query.challenge) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::Value::Null)).into_response();
    }
    let pid = crate::host_pid::current();
    let machine_id = context.state.machine.machine_id.clone();
    let fingerprint = context.state.machine.fingerprint();
    let proof = health_proof(
        &context.state.token,
        &query.challenge,
        pid,
        &machine_id,
        &fingerprint,
    );
    (
        StatusCode::OK,
        Json(HealthResponse {
            pid,
            machine_id,
            fingerprint,
            proof,
        }),
    )
        .into_response()
}

/// Ends the daemon on request from the shell that owns this machine.
///
/// Restricted to loopback in addition to the action proof. Remote shutdown is
/// a separate authenticated protocol operation; this endpoint exists only for
/// the same-user CLI and desktop supervisor.
async fn shutdown(
    State(context): State<Context_>,
    Query(params): Query<ShutdownQuery>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> impl IntoResponse {
    if !remote.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "shutdown is loopback only");
    }
    if !valid_control_challenge(&params.challenge) || params.pid != crate::host_pid::current() {
        return (StatusCode::UNAUTHORIZED, "invalid shutdown proof");
    }
    let expected = shutdown_proof(
        &context.state.token,
        &params.challenge,
        params.pid,
        &context.state.machine.machine_id,
        &context.state.machine.fingerprint(),
        params.expires_at,
    );
    if !token_matches(&expected, &params.proof)
        || !consume_control_admission(
            &context.used_control_admissions,
            "shutdown",
            &params.challenge,
            params.expires_at,
        )
    {
        return (StatusCode::UNAUTHORIZED, "invalid shutdown proof");
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

#[derive(Deserialize)]
struct ShutdownQuery {
    challenge: String,
    pid: u32,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    proof: String,
}

#[derive(Deserialize)]
struct CliQuery {
    challenge: String,
    pid: u32,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
    proof: String,
}

#[derive(Deserialize)]
struct CliBody {
    argv: Vec<String>,
    cwd: String,
    stdin: Option<String>,
}

const MAX_CLI_STDIN_BYTES: usize = 1024 * 1024;

/// Forwards one native `genet` invocation into the guest verb front.
///
/// Loopback plus a `cli`-domain proof. The body is argv/cwd/stdin; the
/// response is NDJSON records as the verb prints, then `{"exit":N}`.
async fn cli(
    State(context): State<Context_>,
    Query(params): Query<CliQuery>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CliBody>,
) -> impl IntoResponse {
    if !remote.ip().is_loopback() {
        return (StatusCode::FORBIDDEN, "cli is loopback only").into_response();
    }
    if !valid_control_challenge(&params.challenge) || params.pid != crate::host_pid::current() {
        return (StatusCode::UNAUTHORIZED, "invalid cli proof").into_response();
    }
    let expected = cli_proof(
        &context.state.token,
        &params.challenge,
        params.pid,
        &context.state.machine.machine_id,
        &context.state.machine.fingerprint(),
        params.expires_at,
    );
    if !token_matches(&expected, &params.proof)
        || !consume_control_admission(
            &context.used_control_admissions,
            "cli",
            &params.challenge,
            params.expires_at,
        )
    {
        return (StatusCode::UNAUTHORIZED, "invalid cli proof").into_response();
    }

    let stdin = match decode_cli_stdin(body.stdin.as_deref()) {
        Ok(stdin) => stdin,
        Err(message) => return (StatusCode::BAD_REQUEST, message).into_response(),
    };
    let cwd = std::path::PathBuf::from(body.cwd);
    let (tx, rx) = mpsc::unbounded_channel();
    let state = context.state.clone();
    tokio::spawn(crate::cli_front::invoke(
        state,
        crate::cli_front::Invocation {
            argv: body.argv,
            cwd,
            stdin,
        },
        tx,
    ));

    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        let record = rx.recv().await?;
        let line = format!("{}\n", cli_record_json(&record));
        Some((Ok::<_, std::io::Error>(bytes::Bytes::from(line)), rx))
    });
    (
        StatusCode::OK,
        [(
            axum::http::header::CONTENT_TYPE,
            "application/x-ndjson; charset=utf-8",
        )],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

fn decode_cli_stdin(encoded: Option<&str>) -> Result<Vec<u8>, &'static str> {
    let Some(encoded) = encoded.filter(|value| !value.is_empty()) else {
        return Ok(Vec::new());
    };
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "stdin is not valid standard base64")?;
    if bytes.len() > MAX_CLI_STDIN_BYTES {
        return Err("stdin exceeds 1 MiB");
    }
    Ok(bytes)
}

fn cli_record_json(record: &crate::cli_front::CliRecord) -> serde_json::Value {
    match record {
        crate::cli_front::CliRecord::Stdout { line } => {
            serde_json::json!({"stream": "stdout", "line": line})
        }
        crate::cli_front::CliRecord::Stderr { text } => {
            serde_json::json!({"stream": "stderr", "text": text})
        }
        crate::cli_front::CliRecord::Exit { code } => serde_json::json!({"exit": code}),
    }
}

async fn upgrade(
    State(context): State<Context_>,
    Query(params): Query<WebSocketAdmission>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !remote.ip().is_loopback()
        || !valid_control_challenge(&params.challenge)
        || params.pid != crate::host_pid::current()
    {
        return (StatusCode::UNAUTHORIZED, "invalid websocket admission").into_response();
    }
    let expected = websocket_proof(
        &context.state.token,
        &params.challenge,
        params.pid,
        &context.state.machine.machine_id,
        &context.state.machine.fingerprint(),
        params.expires_at,
    );
    if !token_matches(&expected, &params.proof)
        || !consume_control_admission(
            &context.used_control_admissions,
            "websocket",
            &params.challenge,
            params.expires_at,
        )
    {
        return (StatusCode::UNAUTHORIZED, "invalid websocket admission").into_response();
    }

    let server_proof = websocket_server_proof(
        &context.state.token,
        &params.challenge,
        params.pid,
        &context.state.machine.machine_id,
        &context.state.machine.fingerprint(),
        params.expires_at,
    );

    ws.max_message_size(MAX_WS_MESSAGE_BYTES)
        .max_frame_size(MAX_WS_MESSAGE_BYTES)
        .on_upgrade(move |socket| connection(socket, context, remote.ip(), server_proof))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WebSocketAdmission {
    challenge: String,
    pid: u32,
    expires_at: u64,
    proof: String,
}

fn consume_control_admission(
    used: &std::sync::Mutex<HashMap<String, u64>>,
    action: &str,
    challenge: &str,
    expires_at: u64,
) -> bool {
    let now = unix_seconds();
    if expires_at <= now || expires_at > now.saturating_add(ADMISSION_LIFETIME_SECS) {
        return false;
    }
    let mut used = used.lock().expect("websocket admission lock");
    used.retain(|_, expiry| *expiry > now);
    let key = format!("{action}:{challenge}");
    if used.contains_key(&key) {
        return false;
    }
    // Never evict a live entry: doing so would make its already-consumed proof
    // replayable during the remainder of its validity window. At capacity we
    // reject the new admission and recover naturally as entries expire.
    if used.len() >= MAX_USED_CONTROL_ADMISSIONS {
        return false;
    }
    used.insert(key, expires_at);
    true
}

async fn connection(
    mut socket: WebSocket,
    context: Context_,
    remote: IpAddr,
    server_proof: String,
) {
    // The first and only plaintext application message is the bounded mutual
    // handshake. Identity and every business byte are sent after E2EE starts.
    let hello = match tokio::time::timeout(WS_HANDSHAKE_TIMEOUT, socket.next()).await {
        Ok(Some(Ok(Message::Binary(bytes)))) => bytes,
        _ => return,
    };
    let accepted = match handshake::accept(
        &context.state,
        router::transport_for(Some(remote)),
        Admission::Loopback { server_proof },
        &hello,
        None,
        None,
    ) {
        Ok(accepted) => accepted,
        Err(error) => {
            tracing::debug!(%error, "local data-plane handshake rejected");
            return;
        }
    };
    let welcome = match serde_json::to_vec(&accepted.welcome) {
        Ok(welcome) => welcome,
        Err(_) => return,
    };
    if !matches!(
        tokio::time::timeout(
            WS_WRITE_TIMEOUT,
            socket.send(Message::Binary(welcome.into())),
        )
        .await,
        Ok(Ok(()))
    ) {
        return;
    }

    let (mut sink, mut stream) = socket.split();
    let (inbound, mut outbound, carrier) = endpoint::carrier_channels();
    let mut writer = tokio::spawn(async move {
        while let Some(record) = outbound.recv().await {
            if !matches!(
                tokio::time::timeout(WS_WRITE_TIMEOUT, sink.send(Message::Binary(record.into())),)
                    .await,
                Ok(Ok(()))
            ) {
                break;
            }
        }
    });
    let mut endpoint = tokio::spawn(endpoint::serve(
        context.state,
        accepted.key,
        accepted.access,
        carrier,
        endpoint::CarrierKind::WebSocket,
    ));
    let reader = async move {
        while let Some(Ok(message)) = stream.next().await {
            match message {
                Message::Binary(record) if record.len() <= MAX_WS_MESSAGE_BYTES => {
                    if inbound.send(record.to_vec()).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                // WebSocket ping/pong stays transport-local. Text and oversized
                // binary messages are never part of protocol v3.
                Message::Ping(_) | Message::Pong(_) => continue,
                _ => break,
            }
        }
    };
    tokio::pin!(reader);

    tokio::select! {
        _ = &mut reader => {},
        _ = &mut endpoint => {},
        _ = &mut writer => {},
    }
    endpoint.abort();
    writer.abort();
}

pub type SharedListener = Arc<Listener>;

#[cfg(test)]
mod tests {
    use super::*;

    // Only the tests mint here: in the product these URLs are minted by the
    // native front door and handed to this listener, never the other way round.
    use genet_frontdoor::proof::{cli_url, websocket_admission, websocket_url};

    // Proof shapes are covered where they are minted, in
    // `genet_frontdoor::proof`. What is worth asserting here is that this
    // listener actually refuses what those proofs say it should refuse.

    #[tokio::test]
    async fn websocket_admissions_are_single_use_short_lived_and_domain_separated() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let admission = websocket_admission(
            listener.port,
            &state.token,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        let url = admission.url.clone();
        let (mut socket, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let client_nonce = "11".repeat(16);
        let hello = genehub_proto::PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: "test".into(),
            auth: genehub_proto::PeerAuth::Loopback {
                context: "loopback".into(),
                nonce: client_nonce.clone(),
                proof: crate::channel_auth::client_proof(
                    &admission.server_proof,
                    "loopback",
                    &client_nonce,
                ),
            },
            rtc_supported: false,
        };
        socket
            .send(tokio_tungstenite::tungstenite::Message::Binary(
                serde_json::to_vec(&hello).unwrap(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap();
        let welcome: genehub_proto::PeerWelcome =
            serde_json::from_slice(&reply.into_data()).unwrap();
        crate::channel_auth::verify_proof(
            &crate::channel_auth::server_proof(
                &admission.server_proof,
                "loopback",
                &client_nonce,
                &welcome.server_nonce,
            ),
            &welcome.proof,
        )
        .unwrap();
        drop(socket);
        assert!(
            tokio_tungstenite::connect_async(&url).await.is_err(),
            "a captured admission must not be replayable"
        );

        let fresh = websocket_url(
            listener.port,
            &state.token,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        let (socket, _) = tokio_tungstenite::connect_async(&fresh).await.unwrap();
        drop(socket);

        let challenge = crate::devices::random_token();
        let expired_at = unix_seconds().saturating_sub(1);
        let expired = websocket_proof(
            &state.token,
            &challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expired_at,
        );
        let expired_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={expired_at}&proof={expired}",
            listener.port,
            crate::host_pid::current(),
        );
        assert!(tokio_tungstenite::connect_async(expired_url).await.is_err());

        let challenge = crate::devices::random_token();
        let far_future = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS + 1);
        let far_future_proof = websocket_proof(
            &state.token,
            &challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            far_future,
        );
        let far_future_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={far_future}&proof={far_future_proof}",
            listener.port,
            crate::host_pid::current(),
        );
        assert!(tokio_tungstenite::connect_async(far_future_url)
            .await
            .is_err());

        let challenge = crate::devices::random_token();
        let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
        let wrong_domain = shutdown_proof(
            &state.token,
            &challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expires_at,
        );
        let wrong_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={wrong_domain}",
            listener.port,
            crate::host_pid::current(),
        );
        assert!(tokio_tungstenite::connect_async(wrong_url).await.is_err());

        let legacy_url = format!("ws://127.0.0.1:{}/ws?token={}", listener.port, state.token);
        assert!(tokio_tungstenite::connect_async(legacy_url).await.is_err());
        listener.handle.abort();
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

        let challenge = "fresh-shutdown-challenge";
        let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
        let proof = shutdown_proof(
            &state.token,
            challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expires_at,
        );
        let url = format!(
            "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={proof}",
            listener.port,
            crate::host_pid::current(),
        );
        assert!(!url.contains(&state.token));
        let answer = crate::http::Client::new()
            .post(&url)
            .send()
            .await
            .expect("the request reaches the daemon");
        assert_eq!(answer.status(), 202);
        let replay = crate::http::Client::new().post(url).send().await.unwrap();
        assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);

        // Only now does the main loop begin waiting.
        tokio::time::timeout(std::time::Duration::from_secs(2), state.shutdown.notified())
            .await
            .expect("the daemon was told to stop and must still know it");

        listener.handle.abort();
    }

    #[tokio::test]
    async fn a_wrong_shutdown_proof_is_unauthorized_and_cannot_control_the_websocket() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let challenge = "attacker-challenge";
        let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
        let health_mac = health_proof(
            &state.token,
            challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        assert_ne!(
            health_mac,
            shutdown_proof(
                &state.token,
                challenge,
                crate::host_pid::current(),
                &state.machine.machine_id,
                &state.machine.fingerprint(),
                expires_at,
            ),
            "health and shutdown proofs must be domain-separated"
        );
        assert!(!token_matches(&state.token, &health_mac));

        let response = crate::http::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={health_mac}",
                listener.port,
                crate::host_pid::current(),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let expired_at = unix_seconds().saturating_sub(1);
        let expired_proof = shutdown_proof(
            &state.token,
            challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expired_at,
        );
        let expired = crate::http::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expired_at}&proof={expired_proof}",
                listener.port,
                crate::host_pid::current(),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(expired.status(), StatusCode::UNAUTHORIZED);
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                state.shutdown.notified(),
            )
            .await
            .is_err(),
            "an invalid proof must not stop the daemon"
        );
        listener.handle.abort();
    }

    #[test]
    fn admission_cache_is_bounded_without_making_live_proofs_replayable() {
        let used = std::sync::Mutex::new(HashMap::new());
        let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
        for index in 0..MAX_USED_CONTROL_ADMISSIONS {
            assert!(consume_control_admission(
                &used,
                "websocket",
                &format!("challenge-{index}"),
                expires_at,
            ));
        }
        assert!(!consume_control_admission(
            &used,
            "websocket",
            "challenge-0",
            expires_at,
        ));
        assert!(!consume_control_admission(
            &used,
            "websocket",
            "capacity-plus-one",
            expires_at,
        ));

        for expiry in used.lock().unwrap().values_mut() {
            *expiry = unix_seconds();
        }
        assert!(consume_control_admission(
            &used,
            "websocket",
            "after-expiry",
            expires_at,
        ));
    }

    #[tokio::test]
    async fn plaintext_lan_mode_fails_closed_instead_of_exposing_the_machine_bearer() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        state.config.write().await.lan_enabled = true;

        let error = match serve(state, pty_fanout(pty_rx)).await {
            Ok(_) => panic!("plaintext LAN mode unexpectedly started"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("plaintext ws://"));
    }

    #[tokio::test]
    async fn health_proves_the_exact_private_endpoint_without_returning_its_bearer() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let challenge = "fresh-health-challenge";
        let response = crate::http::get(format!(
            "http://127.0.0.1:{}/health?challenge={challenge}",
            listener.port
        ))
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["pid"], crate::host_pid::current());
        assert_eq!(body["machineId"], state.machine.machine_id);
        assert_eq!(body["fingerprint"], state.machine.fingerprint());
        assert_eq!(
            body["proof"],
            health_proof(
                &state.token,
                challenge,
                crate::host_pid::current(),
                &state.machine.machine_id,
                &state.machine.fingerprint(),
            )
        );
        assert!(!body.to_string().contains(&state.token));
        listener.handle.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cli_forwards_schema_without_opening_a_websocket() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let url = cli_url(
            listener.port,
            &state.token,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        let response = crate::http::Client::new()
            .post(&url)
            .json(&serde_json::json!({
                "argv": ["schema"],
                "cwd": dir.path().to_string_lossy(),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!url.contains(&state.token));
        let body = response.text().await.unwrap();
        let mut exit = None;
        let mut saw_schema = false;
        for line in body.lines() {
            let value: serde_json::Value = serde_json::from_str(line).unwrap();
            if let Some(code) = value.get("exit").and_then(|value| value.as_i64()) {
                exit = Some(code);
            }
            if value["stream"] == "stdout" {
                let printed = value["line"].as_str().unwrap();
                assert!(
                    printed.contains("genet.cli/v1") || printed.contains("\"schema\""),
                    "{printed}"
                );
                saw_schema = true;
            }
        }
        assert_eq!(exit, Some(0));
        assert!(saw_schema);
        listener.handle.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn cli_machine_selector_does_not_run_the_command_locally() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let url = cli_url(
            listener.port,
            &state.token,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        let response = crate::http::Client::new()
            .post(&url)
            .json(&serde_json::json!({
                "argv": ["--machine", "m_not_paired", "session", "list"],
                "cwd": dir.path().to_string_lossy(),
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.text().await.unwrap();
        assert!(
            !body.contains("\"sessions\""),
            "a missing --machine must not fall back to this daemon's session list: {body}"
        );
        assert!(
            body.contains("fabric")
                || body.contains("machineNotPaired")
                || body.contains("not a machine"),
            "must fail honestly rather than run locally: {body}"
        );
        listener.handle.abort();
    }

    #[tokio::test]
    async fn a_shutdown_proof_cannot_authorize_cli() {
        let dir = tempfile::tempdir().unwrap();
        let (state, pty_rx) = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout(pty_rx)).await.unwrap();
        let challenge = crate::devices::random_token();
        let expires_at = unix_seconds().saturating_add(ADMISSION_LIFETIME_SECS);
        let proof = shutdown_proof(
            &state.token,
            &challenge,
            crate::host_pid::current(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expires_at,
        );
        let response = crate::http::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/cli?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={proof}",
                listener.port,
                crate::host_pid::current(),
            ))
            .json(&serde_json::json!({
                "argv": ["schema"],
                "cwd": "/",
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        listener.handle.abort();
    }
}
