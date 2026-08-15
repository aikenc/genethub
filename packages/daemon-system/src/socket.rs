use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityFailure, CapabilityFailureKind, CapabilityValue, SocketRequest,
    MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::sync::{mpsc, RwLock};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

use crate::failure;

#[derive(Clone)]
pub struct Sockets {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    resources: RwLock<HashMap<u64, mpsc::Sender<Command>>>,
    events: mpsc::Sender<CapabilityEvent>,
}

enum Command {
    Send(Vec<u8>),
    Close,
}

impl Sockets {
    pub fn new(events: mpsc::Sender<CapabilityEvent>) -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                resources: RwLock::new(HashMap::new()),
                events,
            }),
        }
    }

    pub async fn execute(
        &self,
        request: SocketRequest,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            SocketRequest::Connect {
                url,
                headers,
                max_message_bytes,
            } => self.connect(url, headers, max_message_bytes).await,
            SocketRequest::Send { resource_id, bytes } => {
                checked_message(&bytes)?;
                self.command(resource_id, Command::Send(bytes)).await?;
                Ok(CapabilityValue::Unit)
            }
            SocketRequest::Close { resource_id } => {
                self.command(resource_id, Command::Close).await?;
                Ok(CapabilityValue::Unit)
            }
        }
    }

    async fn connect(
        &self,
        url: String,
        headers: Vec<(String, String)>,
        max_message_bytes: u32,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        let limit = max_message_bytes as usize;
        if limit == 0 || limit > MAX_CAPABILITY_CHUNK_BYTES {
            return Err(failure(
                CapabilityFailureKind::TooLarge,
                "socket message limit is empty or exceeds the capability chunk limit",
            ));
        }
        let parsed = reqwest::Url::parse(&url).map_err(|error| {
            failure(
                CapabilityFailureKind::Invalid,
                format!("invalid socket URL: {error}"),
            )
        })?;
        if !matches!(parsed.scheme(), "ws" | "wss") {
            return Err(failure(
                CapabilityFailureKind::Denied,
                "socket capability accepts only ws and wss URLs",
            ));
        }
        let mut request = url.into_client_request().map_err(|error| {
            failure(
                CapabilityFailureKind::Invalid,
                format!("building socket request: {error}"),
            )
        })?;
        for (name, value) in headers {
            let name = name
                .parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
                .map_err(|error| {
                    failure(
                        CapabilityFailureKind::Invalid,
                        format!("invalid socket header name: {error}"),
                    )
                })?;
            let value = value
                .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
                .map_err(|error| {
                    failure(
                        CapabilityFailureKind::Invalid,
                        format!("invalid socket header value: {error}"),
                    )
                })?;
            request.headers_mut().append(name, value);
        }
        let (socket, _) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(socket_failure)?;
        let resource_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (commands, command_rx) = mpsc::channel(256);
        self.inner
            .resources
            .write()
            .await
            .insert(resource_id, commands);
        tokio::spawn(run_socket(
            self.inner.clone(),
            resource_id,
            limit,
            socket,
            command_rx,
        ));
        Ok(CapabilityValue::Resource { resource_id })
    }

    async fn command(&self, resource_id: u64, command: Command) -> Result<(), CapabilityFailure> {
        let sender = self
            .inner
            .resources
            .read()
            .await
            .get(&resource_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    CapabilityFailureKind::NotFound,
                    format!("no socket resource {resource_id}"),
                )
            })?;
        sender.send(command).await.map_err(|_| {
            failure(
                CapabilityFailureKind::Unavailable,
                format!("socket resource {resource_id} is closed"),
            )
        })
    }

    pub async fn close_all(&self) {
        let senders = self
            .inner
            .resources
            .read()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for sender in senders {
            let _ = sender.send(Command::Close).await;
        }
        self.inner.resources.write().await.clear();
    }
}

async fn run_socket<S>(
    inner: Arc<Inner>,
    resource_id: u64,
    max_message_bytes: usize,
    socket: tokio_tungstenite::WebSocketStream<S>,
    mut commands: mpsc::Receiver<Command>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
{
    let (mut output, mut input) = socket.split();
    let reason = loop {
        tokio::select! {
            command = commands.recv() => match command {
                Some(Command::Send(bytes)) => {
                    if let Err(error) = output.send(Message::Binary(bytes.into())).await {
                        break error.to_string();
                    }
                }
                Some(Command::Close) | None => {
                    let _ = output.send(Message::Close(None)).await;
                    break "closed by guest".to_string();
                }
            },
            message = input.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    let bytes = text.as_bytes();
                    if bytes.len() > max_message_bytes {
                        break "socket message exceeded its limit".to_string();
                    }
                    if inner.events.send(CapabilityEvent::SocketMessage {
                        resource_id,
                        bytes: bytes.to_vec(),
                    }).await.is_err() {
                        break "capability event receiver closed".to_string();
                    }
                }
                Some(Ok(Message::Binary(bytes))) => {
                    if bytes.len() > max_message_bytes {
                        break "socket message exceeded its limit".to_string();
                    }
                    if inner.events.send(CapabilityEvent::SocketMessage {
                        resource_id,
                        bytes: bytes.to_vec(),
                    }).await.is_err() {
                        break "capability event receiver closed".to_string();
                    }
                }
                Some(Ok(Message::Ping(bytes))) => {
                    if let Err(error) = output.send(Message::Pong(bytes)).await {
                        break error.to_string();
                    }
                }
                Some(Ok(Message::Pong(_))) | Some(Ok(Message::Frame(_))) => {}
                Some(Ok(Message::Close(frame))) => {
                    break frame.map(|frame| frame.reason.to_string()).unwrap_or_else(|| "peer closed".to_string());
                }
                Some(Err(error)) => break error.to_string(),
                None => break "socket stream ended".to_string(),
            }
        }
    };
    inner.resources.write().await.remove(&resource_id);
    let _ = inner
        .events
        .send(CapabilityEvent::SocketClosed {
            resource_id,
            reason,
        })
        .await;
}

fn checked_message(bytes: &[u8]) -> Result<(), CapabilityFailure> {
    if bytes.len() > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "socket write exceeds the capability chunk limit",
        ));
    }
    Ok(())
}

fn socket_failure(error: tokio_tungstenite::tungstenite::Error) -> CapabilityFailure {
    let kind = match error {
        tokio_tungstenite::tungstenite::Error::Url(_)
        | tokio_tungstenite::tungstenite::Error::HttpFormat(_)
        | tokio_tungstenite::tungstenite::Error::Capacity(_) => CapabilityFailureKind::Invalid,
        _ => CapabilityFailureKind::Unavailable,
    };
    failure(kind, error.to_string())
}
