//! Scoped browser HTTP/WebSocket adapter for a registered source-machine run.

use std::{collections::BTreeMap, io, sync::Arc, time::Duration};

use anyhow::{bail, Context, Result};
use futures_util::{stream, SinkExt, StreamExt};
use hmac::{Hmac, Mac};
use http_body_util::{BodyExt, StreamBody};
use hyper::{
    body::{Bytes, Frame, Incoming},
    header::{self, HeaderValue},
    upgrade::OnUpgrade,
    HeaderMap, Method, Request, Response, StatusCode, Version,
};
use hyper_util::rt::TokioIo;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::{sync::Semaphore, time::timeout};
use tokio_tungstenite::{
    tungstenite::{
        handshake::derive_accept_key,
        protocol::{frame::coding::CloseCode, CloseFrame, Role, WebSocketConfig},
        Message,
    },
    WebSocketStream,
};

use super::{empty, empty_body, Body, View};

const MAX_PACKET: usize = 256 * 1024;
const MAX_BODY: usize = 8 * 1024 * 1024;
const CHUNK: usize = 32 * 1024;
const WAIT: Duration = Duration::from_secs(15);
const RESPONSE_WAIT: Duration = Duration::from_secs(120);
const REQUEST_HEADERS: &[&str] = &[
    "accept",
    "content-type",
    "range",
    "if-none-match",
    "last-event-id",
];
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
];

#[cfg(not(target_family = "wasm"))]
type Runner = WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;
#[cfg(target_family = "wasm")]
type Runner = crate::transport::ws::Socket;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Run {
    run_id: String,
    secret: String,
    port: u16,
    routes: Vec<Route>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Route {
    prefix: String,
    websocket: bool,
}

impl Run {
    pub(super) fn validate(&self) -> Result<()> {
        if self.port == 0
            || !hex_of_len(&self.secret, 64)
            || !hex_of_len(&self.run_id, 32)
            || self.routes.is_empty()
            || self.routes.len() > 32
            || self.routes.iter().any(|route| {
                !valid_path(&route.prefix)
                    || !route.prefix.ends_with('/')
                    || route.prefix.len() > 256
            })
        {
            bail!("invalid preview service binding");
        }
        Ok(())
    }

    fn permits(&self, path: &str, websocket: bool) -> bool {
        valid_path(path)
            && self
                .routes
                .iter()
                .filter(|route| path.starts_with(&route.prefix))
                .max_by_key(|route| route.prefix.len())
                .is_some_and(|route| !websocket || route.websocket)
    }

    async fn connect(&self) -> Result<Runner> {
        let url = format!("ws://127.0.0.1:{}/", self.port);
        #[cfg(not(target_family = "wasm"))]
        let (mut socket, _) =
            tokio_tungstenite::connect_async_with_config(url, config(), true).await?;
        #[cfg(target_family = "wasm")]
        let mut socket = crate::transport::ws::connect(&url, config().unwrap_or_default()).await?;
        let nonce = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        send_control(&mut socket, json!({"nonce":nonce})).await?;
        let proof = receive_control(&mut socket).await?;
        let actual = proof["proof"].as_str().context("missing run proof")?;
        let expected = self.proof("server", &nonce);
        if !bool::from(expected.as_bytes().ct_eq(actual.as_bytes())) {
            bail!("registered service run changed");
        }
        send_control(&mut socket, json!({"proof":self.proof("client", &nonce)})).await?;
        if receive_control(&mut socket).await?["kind"] != "ready" {
            bail!("registered service run unavailable");
        }
        Ok(socket)
    }

    fn proof(&self, role: &str, nonce: &str) -> String {
        let mut mac =
            Hmac::<Sha256>::new_from_slice(self.secret.as_bytes()).expect("valid HMAC key");
        mac.update(format!("{role}:{nonce}:{}", self.run_id).as_bytes());
        format!("{:x}", mac.finalize().into_bytes())
    }
}

fn hex_of_len(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_path(path: &str) -> bool {
    path.starts_with("/api/")
        && !path.contains(['%', '\\', '#', '?'])
        && !path.contains("//")
        && !path.split('/').any(|part| part == "." || part == "..")
}

fn config() -> Option<WebSocketConfig> {
    Some(WebSocketConfig {
        max_message_size: Some(MAX_PACKET),
        max_frame_size: Some(MAX_PACKET),
        max_write_buffer_size: 512 * 1024,
        ..Default::default()
    })
}

async fn send_control(socket: &mut Runner, value: Value) -> Result<()> {
    send_packet(socket, 0, &serde_json::to_vec(&value)?).await
}

async fn send_packet(socket: &mut Runner, kind: u8, bytes: &[u8]) -> Result<()> {
    if bytes.len() >= MAX_PACKET {
        bail!("service packet exceeds limit");
    }
    let mut packet = Vec::with_capacity(bytes.len() + 1);
    packet.push(kind);
    packet.extend_from_slice(bytes);
    socket.send(Message::Binary(packet)).await?;
    Ok(())
}

async fn receive(socket: &mut Runner) -> Result<Vec<u8>> {
    loop {
        match socket.next().await.context("service run disconnected")?? {
            Message::Binary(packet) if !packet.is_empty() => return Ok(packet),
            Message::Ping(_) => socket.flush().await?,
            Message::Pong(_) => {}
            _ => bail!("invalid service packet"),
        }
    }
}

fn control(packet: &[u8]) -> Result<Value> {
    if packet[0] != 0 {
        bail!("expected service control packet");
    }
    Ok(serde_json::from_slice(&packet[1..])?)
}

async fn acknowledge(socket: &mut Runner) -> Result<()> {
    timeout(WAIT, socket.send(Message::Binary(vec![2]))).await??;
    Ok(())
}

async fn receive_control(socket: &mut Runner) -> Result<Value> {
    control(&receive(socket).await?)
}

fn same_origin(headers: &HeaderMap, origin: &HeaderValue, websocket: bool) -> bool {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|site| site != "same-origin")
    {
        return false;
    }
    match headers.get(header::ORIGIN) {
        Some(header) => header == origin && headers.get_all(header::ORIGIN).iter().count() == 1,
        None => {
            !websocket
                && headers
                    .get("sec-fetch-site")
                    .is_some_and(|site| site == "same-origin")
        }
    }
}

pub(super) async fn respond(
    mut request: Request<Incoming>,
    view: Arc<View>,
    run: &Run,
    slots: &Arc<Semaphore>,
) -> Response<Body> {
    let websocket = request.headers().contains_key(header::UPGRADE);
    if !same_origin(request.headers(), &view.origin, websocket) {
        return empty(StatusCode::FORBIDDEN);
    }
    let path = request
        .uri()
        .path_and_query()
        .map(|path| path.as_str())
        .unwrap_or_default();
    if path.len() > 4096 || !run.permits(request.uri().path(), websocket) {
        return empty(StatusCode::FORBIDDEN);
    }
    let path = path.to_owned();
    let accept = if websocket {
        let Some(key) = browser_upgrade(&request) else {
            return empty(StatusCode::BAD_REQUEST);
        };
        Some(derive_accept_key(key))
    } else {
        if !matches!(
            *request.method(),
            Method::GET
                | Method::HEAD
                | Method::POST
                | Method::PUT
                | Method::PATCH
                | Method::DELETE
                | Method::OPTIONS
        ) {
            return empty(StatusCode::METHOD_NOT_ALLOWED);
        }
        None
    };
    let Ok(slot) = slots.clone().try_acquire_owned() else {
        return empty(StatusCode::SERVICE_UNAVAILABLE);
    };
    let Ok(Ok(mut runner)) = timeout(WAIT, run.connect()).await else {
        return empty(StatusCode::BAD_GATEWAY);
    };
    if let Some(accept) = accept {
        let ready = async {
            send_control(&mut runner, json!({"kind":"ws","path":path})).await?;
            let response = receive_control(&mut runner).await?;
            acknowledge(&mut runner).await?;
            Ok::<_, anyhow::Error>(response)
        };
        if !matches!(timeout(WAIT, ready).await, Ok(Ok(message)) if message["kind"] == "open") {
            return empty(StatusCode::BAD_GATEWAY);
        }
        let upgrade = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            let _slot = slot;
            let mut revoked = view.revoked.subscribe();
            tokio::select! {
                _ = revoked.wait_for(|revoked| *revoked) => {}
                _ = tokio::time::sleep_until(view.deadline) => {}
                _ = relay_websocket(upgrade, runner) => {}
            }
        });
        return Response::builder()
            .status(StatusCode::SWITCHING_PROTOCOLS)
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .header(header::SEC_WEBSOCKET_ACCEPT, accept)
            .body(empty_body())
            .expect("valid upgrade response");
    }

    match timeout(RESPONSE_WAIT, relay_http(request, path, runner, slot)).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => empty(error),
        Err(_) => empty(StatusCode::GATEWAY_TIMEOUT),
    }
}

fn browser_upgrade(request: &Request<Incoming>) -> Option<&[u8]> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let headers = request.headers();
    if request.method() != Method::GET
        || request.version() != Version::HTTP_11
        || headers.get(header::SEC_WEBSOCKET_VERSION)? != "13"
        || headers.contains_key(header::SEC_WEBSOCKET_PROTOCOL)
        || !headers
            .get(header::UPGRADE)?
            .to_str()
            .ok()?
            .eq_ignore_ascii_case("websocket")
        || !headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|value| value.split(','))
            .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    {
        return None;
    }
    let key = headers.get(header::SEC_WEBSOCKET_KEY)?.as_bytes();
    (STANDARD.decode(key).ok()?.len() == 16).then_some(key)
}

async fn relay_websocket(upgrade: OnUpgrade, mut runner: Runner) -> Result<()> {
    let connection = timeout(WAIT, upgrade).await??;
    let mut browser =
        WebSocketStream::from_raw_socket(TokioIo::new(connection), Role::Server, config()).await;
    loop {
        tokio::select! {
            message = browser.next() => {
                match message.context("browser connection closed")?? {
                    Message::Text(text) => send_control(&mut runner, json!({"kind":"text","text":text})).await?,
                    Message::Binary(bytes) => send_packet(&mut runner, 1, &bytes).await?,
                    Message::Close(_) => {
                        browser.flush().await?;
                        send_control(&mut runner, json!({"kind":"close"})).await?;
                        return Ok(());
                    }
                    Message::Ping(_) => browser.flush().await?,
                    _ => {}
                }
            }
            packet = receive(&mut runner) => {
                let packet = packet?;
                let message = if packet[0] == 1 {
                    Message::Binary(packet[1..].to_vec())
                } else {
                    let message = control(&packet)?;
                    match message["kind"].as_str() {
                        Some("text") => Message::Text(message["text"].as_str().context("missing text")?.into()),
                        Some("close") => {
                            let code = message["code"].as_u64().and_then(|value| u16::try_from(value).ok()).unwrap_or(1000);
                            let code = CloseCode::from(code);
                            browser.close(Some(CloseFrame {
                                code: if code.is_allowed() { code } else { CloseCode::Error },
                                reason: "".into(),
                            })).await?;
                            acknowledge(&mut runner).await?;
                            return Ok(());
                        }
                        _ => bail!("invalid WebSocket packet"),
                    }
                };
                browser.send(message).await?;
                acknowledge(&mut runner).await?;
            }
        }
    }
}

async fn relay_http(
    request: Request<Incoming>,
    path: String,
    mut runner: Runner,
    slot: tokio::sync::OwnedSemaphorePermit,
) -> std::result::Result<Response<Body>, StatusCode> {
    let method = request.method().clone();
    let headers: BTreeMap<_, _> = REQUEST_HEADERS
        .iter()
        .filter_map(|&name| Some((name, request.headers().get(name)?.to_str().ok()?)))
        .filter(|(_, value)| value.len() <= 2048)
        .collect();
    let upstream = StatusCode::BAD_GATEWAY;
    send_control(
        &mut runner,
        json!({"kind":"http","path":path,"method":method.as_str(),"headers":headers}),
    )
    .await
    .map_err(|_| upstream)?;
    let mut input = request.into_body();
    let mut received = 0;
    while let Some(frame) = input.frame().await {
        let frame = frame.map_err(|_| StatusCode::BAD_REQUEST)?;
        if let Ok(data) = frame.into_data() {
            received += data.len();
            if received > MAX_BODY {
                return Err(StatusCode::PAYLOAD_TOO_LARGE);
            }
            for chunk in data.chunks(CHUNK) {
                send_packet(&mut runner, 1, chunk)
                    .await
                    .map_err(|_| upstream)?;
            }
        }
    }
    send_control(&mut runner, json!({"kind":"end"}))
        .await
        .map_err(|_| upstream)?;
    let head = receive_control(&mut runner).await.map_err(|_| upstream)?;
    acknowledge(&mut runner).await.map_err(|_| upstream)?;
    if head["kind"] != "head" {
        return Err(upstream);
    }
    let status = head["status"]
        .as_u64()
        .and_then(|status| u16::try_from(status).ok())
        .and_then(|status| StatusCode::from_u16(status).ok())
        .filter(|status| (200..600).contains(&status.as_u16()))
        .ok_or(upstream)?;
    let mut response = Response::builder()
        .status(status)
        .header("cross-origin-resource-policy", "same-origin")
        .header(header::CACHE_CONTROL, "private, no-store")
        .header(
            header::CONTENT_SECURITY_POLICY,
            "default-src 'none'; sandbox",
        )
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    for &name in RESPONSE_HEADERS {
        if let Some(value) = head["headers"][name]
            .as_str()
            .and_then(|value| HeaderValue::from_str(value).ok())
        {
            response = response.header(name, value);
        }
    }
    let body = if method == Method::HEAD || matches!(status.as_u16(), 204 | 205 | 304) {
        empty_body()
    } else {
        let body = stream::try_unfold(
            (runner, slot, false),
            |(mut runner, slot, pending_ack)| async move {
                // The next pull releases credit for the previously delivered chunk.
                if pending_ack {
                    acknowledge(&mut runner).await.map_err(io::Error::other)?;
                }
                let packet = timeout(RESPONSE_WAIT, receive(&mut runner))
                    .await
                    .map_err(io::Error::other)?
                    .map_err(io::Error::other)?;
                if packet[0] == 1 {
                    let data = Bytes::from(packet).slice(1..);
                    Ok(Some((Frame::data(data), (runner, slot, true))))
                } else if control(&packet).map_err(io::Error::other)?["kind"] == "end" {
                    acknowledge(&mut runner).await.map_err(io::Error::other)?;
                    Ok(None)
                } else {
                    Err(io::Error::other("invalid service response stream"))
                }
            },
        );
        StreamBody::new(body).boxed_unsync()
    };
    response.body(body).map_err(|_| upstream)
}
