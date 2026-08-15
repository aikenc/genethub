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
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::sync::broadcast;

use super::admission::Admission;
use super::auth;
use crate::dataplane::{endpoint, handshake};
use crate::router;
use crate::state::Shared;

const MAX_WS_MESSAGE_BYTES: usize = genehub_proto::MAX_DATA_FRAME_BYTES;
const WS_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WS_HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
const WS_ADMISSION_LIFETIME_SECS: u64 = 15;
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

/// Creates the process-wide event bus. Native PTY/process bytes pass through
/// the Wasm application before they are published here.
pub fn pty_fanout() -> PtyFanout {
    broadcast::channel::<ServerFrame>(1024).0
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
    let pid = std::process::id();
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

/// Proof that a health response came from the daemon which owns endpoint.json.
///
/// The endpoint bearer never leaves the machine-private file. A fresh public
/// challenge prevents a stale response from being replayed after the daemon's
/// pid or port has been reused by another process.
pub fn health_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    control_proof(token, b"health", challenge, pid, machine_id, fingerprint)
}

/// One-use proof for the destructive loopback shutdown action.
pub fn shutdown_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"shutdown",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

/// One-use, short-lived admission for opening the privileged loopback WS.
pub fn websocket_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

/// The listener's half of loopback mutual authentication. This value is
/// returned out-of-band by the owner-only CLI/Tauri control path and is never
/// placed in the WebSocket URL, so a process that steals the port cannot forge
/// Hello merely by accepting the upgrade.
pub fn websocket_server_proof(
    token: &str,
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    expiring_control_proof(
        token,
        b"websocket-server",
        challenge,
        pid,
        machine_id,
        fingerprint,
        expires_at,
    )
}

fn expiring_control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
    expires_at: u64,
) -> String {
    let mut mac = control_mac(token, action, challenge, pid, machine_id, fingerprint);
    let expiry = expires_at.to_be_bytes();
    mac.update(&(expiry.len() as u64).to_be_bytes());
    mac.update(&expiry);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn control_proof(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    let mac = control_mac(token, action, challenge, pid, machine_id, fingerprint);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn control_mac(
    token: &str,
    action: &[u8],
    challenge: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> Hmac<Sha256> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(token.as_bytes())
        .expect("HMAC accepts every bearer length");
    for field in [
        b"genehub-loopback-control-v1".as_slice(),
        action,
        challenge.as_bytes(),
        &pid.to_be_bytes(),
        machine_id.as_bytes(),
        fingerprint.as_bytes(),
    ] {
        mac.update(&(field.len() as u64).to_be_bytes());
        mac.update(field);
    }
    mac
}

fn valid_control_challenge(challenge: &str) -> bool {
    !challenge.is_empty()
        && challenge.len() <= 128
        && challenge
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
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
    if !valid_control_challenge(&params.challenge) || params.pid != std::process::id() {
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
    if !auth::token_matches(&expected, &params.proof)
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

async fn upgrade(
    State(context): State<Context_>,
    Query(params): Query<WebSocketAdmission>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    ws: WebSocketUpgrade,
) -> impl IntoResponse {
    if !remote.ip().is_loopback()
        || !valid_control_challenge(&params.challenge)
        || params.pid != std::process::id()
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
    if !auth::token_matches(&expected, &params.proof)
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
    if expires_at <= now || expires_at > now.saturating_add(WS_ADMISSION_LIFETIME_SECS) {
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

fn unix_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
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
    )
    .await
    {
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

/// Mints a short-lived URL without putting the reusable bearer on the wire.
pub struct LocalWebSocketAdmission {
    pub url: String,
    pub server_proof: String,
    pub challenge: String,
    pub pid: u32,
    pub machine_id: String,
    pub fingerprint: String,
    pub expires_at: u64,
}

/// Mints both halves of a short-lived loopback admission. Only `url` crosses
/// the socket boundary; `server_proof` and its transcript travel through the
/// owner-only local control path.
pub fn websocket_admission(
    port: u16,
    token: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> LocalWebSocketAdmission {
    let challenge = crate::channel_auth::random_token();
    let expires_at = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS);
    let proof = websocket_proof(token, &challenge, pid, machine_id, fingerprint, expires_at);
    let server_proof =
        websocket_server_proof(token, &challenge, pid, machine_id, fingerprint, expires_at);
    LocalWebSocketAdmission {
        url: format!(
            "ws://127.0.0.1:{port}/ws?challenge={challenge}&pid={pid}&expiresAt={expires_at}&proof={proof}"
        ),
        server_proof,
        challenge,
        pid,
        machine_id: machine_id.to_owned(),
        fingerprint: fingerprint.to_owned(),
        expires_at,
    }
}

pub fn websocket_url(
    port: u16,
    token: &str,
    pid: u32,
    machine_id: &str,
    fingerprint: &str,
) -> String {
    websocket_admission(port, token, pid, machine_id, fingerprint).url
}

pub type SharedListener = Arc<Listener>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_websocket_url_carries_only_a_short_lived_action_proof() {
        let url = websocket_url(1234, "never-send-me", 42, "machine", "fingerprint");
        assert!(url.starts_with("ws://127.0.0.1:1234/ws?challenge="));
        assert!(url.contains("&pid=42&expiresAt="));
        assert!(url.contains("&proof="));
        assert!(!url.contains("never-send-me"));
        assert!(!url.contains("token="));
    }

    #[test]
    fn websocket_proof_has_a_stable_cross_client_contract() {
        assert_eq!(
            websocket_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            ),
            "cb10c4c41a54062a453ddd359fd970815064e19ac5a5e2c511103a924129c3c7"
        );
        let server = websocket_server_proof(
            "token-1",
            "challenge-1",
            42,
            "machine-1",
            "fingerprint-1",
            1_234_567_890,
        );
        assert_eq!(
            server,
            "6b02a83a6c67e128a762565b92b7184874e9eb806269581b35c8c05f13e3e5c2"
        );
        assert_ne!(
            server,
            websocket_proof(
                "token-1",
                "challenge-1",
                42,
                "machine-1",
                "fingerprint-1",
                1_234_567_890,
            )
        );
    }

    #[tokio::test]
    async fn websocket_admissions_are_single_use_short_lived_and_domain_separated() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout()).await.unwrap();
        let admission = websocket_admission(
            listener.port,
            &state.token,
            std::process::id(),
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
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        let (socket, _) = tokio_tungstenite::connect_async(&fresh).await.unwrap();
        drop(socket);

        let challenge = crate::channel_auth::random_token();
        let expired_at = unix_seconds().saturating_sub(1);
        let expired = websocket_proof(
            &state.token,
            &challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expired_at,
        );
        let expired_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={expired_at}&proof={expired}",
            listener.port,
            std::process::id(),
        );
        assert!(tokio_tungstenite::connect_async(expired_url).await.is_err());

        let challenge = crate::channel_auth::random_token();
        let far_future = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS + 1);
        let far_future_proof = websocket_proof(
            &state.token,
            &challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            far_future,
        );
        let far_future_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={far_future}&proof={far_future_proof}",
            listener.port,
            std::process::id(),
        );
        assert!(tokio_tungstenite::connect_async(far_future_url)
            .await
            .is_err());

        let challenge = crate::channel_auth::random_token();
        let expires_at = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS);
        let wrong_domain = shutdown_proof(
            &state.token,
            &challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expires_at,
        );
        let wrong_url = format!(
            "ws://127.0.0.1:{}/ws?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={wrong_domain}",
            listener.port,
            std::process::id(),
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
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout()).await.unwrap();

        let challenge = "fresh-shutdown-challenge";
        let expires_at = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS);
        let proof = shutdown_proof(
            &state.token,
            challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expires_at,
        );
        let url = format!(
            "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={proof}",
            listener.port,
            std::process::id(),
        );
        assert!(!url.contains(&state.token));
        let answer = reqwest::Client::new()
            .post(&url)
            .send()
            .await
            .expect("the request reaches the daemon");
        assert_eq!(answer.status(), 202);
        let replay = reqwest::Client::new().post(url).send().await.unwrap();
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
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout()).await.unwrap();
        let challenge = "attacker-challenge";
        let expires_at = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS);
        let health_mac = health_proof(
            &state.token,
            challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
        );
        assert_ne!(
            health_mac,
            shutdown_proof(
                &state.token,
                challenge,
                std::process::id(),
                &state.machine.machine_id,
                &state.machine.fingerprint(),
                expires_at,
            ),
            "health and shutdown proofs must be domain-separated"
        );
        assert!(!auth::token_matches(&state.token, &health_mac));

        let response = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expires_at}&proof={health_mac}",
                listener.port,
                std::process::id(),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

        let expired_at = unix_seconds().saturating_sub(1);
        let expired_proof = shutdown_proof(
            &state.token,
            challenge,
            std::process::id(),
            &state.machine.machine_id,
            &state.machine.fingerprint(),
            expired_at,
        );
        let expired = reqwest::Client::new()
            .post(format!(
                "http://127.0.0.1:{}/shutdown?challenge={challenge}&pid={}&expiresAt={expired_at}&proof={expired_proof}",
                listener.port,
                std::process::id(),
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
        let expires_at = unix_seconds().saturating_add(WS_ADMISSION_LIFETIME_SECS);
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
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        state.config.write().await.lan_enabled = true;

        let error = match serve(state, pty_fanout()).await {
            Ok(_) => panic!("plaintext LAN mode unexpectedly started"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("plaintext ws://"));
    }

    #[tokio::test]
    async fn health_proves_the_exact_private_endpoint_without_returning_its_bearer() {
        let dir = tempfile::tempdir().unwrap();
        let state = crate::AppState::build(crate::config::Paths::new(dir.path()))
            .await
            .unwrap();
        let listener = serve(state.clone(), pty_fanout()).await.unwrap();
        let challenge = "fresh-health-challenge";
        let response = reqwest::get(format!(
            "http://127.0.0.1:{}/health?challenge={challenge}",
            listener.port
        ))
        .await
        .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert_eq!(body["pid"], std::process::id());
        assert_eq!(body["machineId"], state.machine.machine_id);
        assert_eq!(body["fingerprint"], state.machine.fingerprint());
        assert_eq!(
            body["proof"],
            health_proof(
                &state.token,
                challenge,
                std::process::id(),
                &state.machine.machine_id,
                &state.machine.fingerprint(),
            )
        );
        assert!(!body.to_string().contains(&state.token));
        listener.handle.abort();
    }
}
