//! A protocol client for tests: real WebSocket, real frames, no shortcuts.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{Reply, Request, SequencedEvent, ServerFrame, SessionEvent, PROTOCOL_VERSION};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio_tungstenite::tungstenite::Message;

/// How long any single wait may take before the test fails.
///
/// Generous enough for a real model call, short enough that a hang surfaces as
/// a failure rather than a stuck CI job.
pub const WAIT_TIMEOUT: Duration = Duration::from_secs(180);

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Reply, String>>>>>;

pub struct Client {
    outbound: mpsc::UnboundedSender<Message>,
    pending: Pending,
    next_id: AtomicU64,
    pub events: Mutex<mpsc::UnboundedReceiver<SequencedEvent>>,
    pub pty: Mutex<mpsc::UnboundedReceiver<(String, String)>>,
    pub notices: Mutex<mpsc::UnboundedReceiver<String>>,
    reader: tokio::task::JoinHandle<()>,
    writer: tokio::task::JoinHandle<()>,
}

impl Client {
    pub async fn connect(url: &str) -> Result<Self> {
        let (socket, _) = tokio_tungstenite::connect_async(url).await?;
        let (mut sink, mut stream) = socket.split();

        let (outbound, mut outbound_rx) = mpsc::unbounded_channel::<Message>();
        let writer = tokio::spawn(async move {
            while let Some(message) = outbound_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (pty_tx, pty_rx) = mpsc::unbounded_channel();
        let (notice_tx, notice_rx) = mpsc::unbounded_channel();

        let reader_pending = pending.clone();
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = stream.next().await {
                let Message::Text(text) = message else {
                    continue;
                };
                let Ok(frame) = serde_json::from_str::<ServerFrame>(&text) else {
                    eprintln!("test client: undecodable frame: {text}");
                    continue;
                };
                match frame {
                    ServerFrame::Result {
                        id,
                        ok,
                        payload,
                        error,
                    } => {
                        if let Some(sender) = reader_pending.lock().await.remove(&id) {
                            let outcome = if ok {
                                Ok(payload.unwrap_or(Reply::Ack))
                            } else {
                                Err(error
                                    .map(|e| format!("{:?}: {}", e.code, e.message))
                                    .unwrap_or_else(|| "unknown error".into()))
                            };
                            let _ = sender.send(outcome);
                        }
                    }
                    ServerFrame::Event { payload, .. } => {
                        let _ = events_tx.send(payload);
                    }
                    ServerFrame::PtyOutput { pty_id, data } => {
                        let _ = pty_tx.send((pty_id, data));
                    }
                    ServerFrame::PtyClosed { pty_id, .. } => {
                        let _ = pty_tx.send((pty_id, String::new()));
                    }
                    ServerFrame::Notice { message, .. } => {
                        let _ = notice_tx.send(message);
                    }
                    // Loud on purpose. The real client closes the gap; a test
                    // client that did the same would paper over dropped events
                    // and turn a lost assertion into a mysterious one.
                    ServerFrame::Desync { session_id, missed } => {
                        panic!("the daemon dropped {missed} events for {session_id}");
                    }
                }
            }

            // A closed socket answers every outstanding call. Leaving them
            // hanging turns "the daemon hung up on us", which several cases are
            // specifically about, into a timeout minutes later.
            for (_, sender) in reader_pending.lock().await.drain() {
                let _ = sender.send(Err("the connection closed".into()));
            }
        });

        Ok(Client {
            outbound,
            pending,
            next_id: AtomicU64::new(1),
            events: Mutex::new(events_rx),
            pty: Mutex::new(pty_rx),
            notices: Mutex::new(notice_rx),
            reader,
            writer,
        })
    }

    pub async fn call(&self, request: Request) -> Result<Reply> {
        let id = format!("c{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let mut envelope = serde_json::to_value(&request)?;
        envelope
            .as_object_mut()
            .ok_or_else(|| anyhow!("a request must encode as an object"))?
            .insert("id".into(), json!(id));
        self.outbound.send(Message::Text(envelope.to_string()))?;

        match tokio::time::timeout(WAIT_TIMEOUT, rx).await {
            Ok(Ok(Ok(reply))) => Ok(reply),
            Ok(Ok(Err(message))) => bail!("{message}"),
            Ok(Err(_)) => bail!("the connection closed before answering"),
            Err(_) => bail!("timed out waiting for a reply"),
        }
    }

    /// Sends a request expecting it to fail, returning the error text.
    pub async fn expect_error(&self, request: Request) -> String {
        match self.call(request).await {
            Ok(reply) => panic!("expected a failure, got {reply:?}"),
            Err(error) => error.to_string(),
        }
    }

    pub async fn hello(&self, name: &str) -> Result<Reply> {
        self.call(Request::Hello {
            client_name: name.to_string(),
            protocol_version: PROTOCOL_VERSION,
            device: None,
        })
        .await
    }

    /// Says hello as a device the machine paired with earlier.
    pub async fn hello_as_device(
        &self,
        name: &str,
        device_id: &str,
        secret: &str,
    ) -> Result<Reply> {
        let nonce = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );
        self.call(Request::Hello {
            client_name: name.to_string(),
            protocol_version: PROTOCOL_VERSION,
            device: Some(genehub_proto::DeviceAuth {
                device_id: device_id.to_string(),
                proof: genet_daemon::devices::proof("client", &nonce, secret),
                nonce,
            }),
        })
        .await
    }

    /// Sends a raw frame, for cases that need to be malformed on purpose.
    pub fn send_raw(&self, raw: &str) -> Result<()> {
        self.outbound.send(Message::Text(raw.to_string()))?;
        Ok(())
    }

    /// Waits until the agent is visibly working, returning the last sequence
    /// number seen on the way.
    ///
    /// "Mid-turn" has to mean something: interrupting or disconnecting before
    /// the model has produced anything tests the request path and nothing else.
    /// A timeline item is the first proof that the answer has started.
    pub async fn wait_for_turn_to_start(&self) -> Result<u64> {
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        let mut events = self.events.lock().await;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("the turn never produced anything");
            }
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) => {
                    let seq = event.seq;
                    match event.event {
                        SessionEvent::Item { .. } | SessionEvent::ItemDelta { .. } => {
                            return Ok(seq)
                        }
                        SessionEvent::TurnCompleted { .. }
                        | SessionEvent::TurnFailed { .. }
                        | SessionEvent::TurnCanceled { .. } => {
                            bail!("the turn was over before it could be caught mid-flight")
                        }
                        _ => continue,
                    }
                }
                Ok(None) => bail!("the event stream closed"),
                Err(_) => bail!("timed out waiting for the turn to start"),
            }
        }
    }

    /// Waits for `session_id` to ask permission for something, returning the
    /// request's id to answer with `session.respondPermission`.
    ///
    /// Events for other sessions are skipped rather than treated as a
    /// mismatch: several journeys share one client across sessions, and this
    /// call only cares about the one it names.
    pub async fn wait_for_permission_request(&self, session_id: &str) -> Result<String> {
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        let mut events = self.events.lock().await;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("no permission request arrived");
            }
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) if event.session_id == session_id => match event.event {
                    SessionEvent::PermissionRequested { request } => return Ok(request.id),
                    SessionEvent::TurnCompleted { .. }
                    | SessionEvent::TurnFailed { .. }
                    | SessionEvent::TurnCanceled { .. } => {
                        bail!("the turn ended without ever asking permission")
                    }
                    _ => continue,
                },
                Ok(Some(_)) => continue,
                Ok(None) => bail!("the event stream closed"),
                Err(_) => bail!("timed out waiting for a permission request"),
            }
        }
    }

    /// Collects events until a turn settles, then returns everything seen.
    ///
    /// Waiting for the terminal event rather than a fixed sleep is what keeps
    /// these tests usable against a real model, whose timing varies wildly.
    pub async fn drain_turn(&self) -> Result<Vec<SessionEvent>> {
        let mut seen = Vec::new();
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        let mut events = self.events.lock().await;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!(
                    "timed out after {} events without a turn ending",
                    seen.len()
                );
            }
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) => {
                    let settled = matches!(
                        event.event,
                        SessionEvent::TurnCompleted { .. }
                            | SessionEvent::TurnFailed { .. }
                            | SessionEvent::TurnCanceled { .. }
                    );
                    seen.push(event.event);
                    if settled {
                        return Ok(seen);
                    }
                }
                Ok(None) => bail!("the event stream closed mid-turn"),
                Err(_) => bail!("timed out waiting for the turn to end"),
            }
        }
    }

    /// Drives several sessions at once, returning each one's events separately.
    ///
    /// Sequential draining would pass even if two agents shared a stream, so
    /// the only way to catch crossed wiring is to have both turns in flight.
    pub async fn drain_turns(
        &self,
        sessions: &[&str],
    ) -> Result<std::collections::HashMap<String, Vec<SessionEvent>>> {
        let mut collected: std::collections::HashMap<String, Vec<SessionEvent>> = sessions
            .iter()
            .map(|id| (id.to_string(), Vec::new()))
            .collect();
        let mut pending: std::collections::HashSet<String> =
            sessions.iter().map(|id| id.to_string()).collect();

        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        let mut events = self.events.lock().await;
        while !pending.is_empty() {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("timed out with {} turns still running", pending.len());
            }
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) => {
                    let settled = matches!(
                        event.event,
                        SessionEvent::TurnCompleted { .. }
                            | SessionEvent::TurnFailed { .. }
                            | SessionEvent::TurnCanceled { .. }
                    );
                    if let Some(bucket) = collected.get_mut(&event.session_id) {
                        bucket.push(event.event);
                        if settled {
                            pending.remove(&event.session_id);
                        }
                    }
                }
                Ok(None) => bail!("the event stream closed mid-turn"),
                Err(_) => bail!("timed out waiting for the turns to end"),
            }
        }
        Ok(collected)
    }

    /// Waits for one event matching a predicate, discarding others.
    pub async fn wait_for<F>(&self, predicate: F) -> Result<SessionEvent>
    where
        F: Fn(&SessionEvent) -> bool,
    {
        let deadline = tokio::time::Instant::now() + WAIT_TIMEOUT;
        let mut events = self.events.lock().await;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                bail!("timed out waiting for a matching event");
            }
            match tokio::time::timeout(remaining, events.recv()).await {
                Ok(Some(event)) if predicate(&event.event) => return Ok(event.event),
                Ok(Some(_)) => continue,
                Ok(None) => bail!("the event stream closed"),
                Err(_) => bail!("timed out waiting for a matching event"),
            }
        }
    }

    pub async fn collect_pty(&self, needle: &str, within: Duration) -> String {
        let mut seen = String::new();
        let deadline = tokio::time::Instant::now() + within;
        let mut pty = self.pty.lock().await;
        while tokio::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            match tokio::time::timeout(remaining, pty.recv()).await {
                Ok(Some((_, data))) => {
                    seen.push_str(&data);
                    if seen.contains(needle) {
                        return seen;
                    }
                }
                _ => break,
            }
        }
        seen
    }

    pub async fn close(self) {
        drop(self.outbound);
        self.reader.abort();
        self.writer.abort();
    }
}

/// Convenience accessors so assertions read as behaviour rather than matching.
pub trait EventsExt {
    fn items(&self) -> Vec<&genehub_proto::TimelineItem>;
    fn tool_calls(&self) -> Vec<(&str, &genehub_proto::ToolCallDetail)>;
    fn assistant_text(&self) -> String;
    fn completed(&self) -> bool;
    fn canceled(&self) -> bool;
    fn failure(&self) -> Option<&genehub_proto::TurnError>;
}

impl EventsExt for [SessionEvent] {
    fn items(&self) -> Vec<&genehub_proto::TimelineItem> {
        self.iter()
            .filter_map(|event| match event {
                SessionEvent::Item { item, .. } => Some(item),
                _ => None,
            })
            .collect()
    }

    /// One entry per call, in the order the calls first appeared, carrying the
    /// last version of each: a call is announced pending and re-sent once it
    /// has run, and what a caller almost always means is the settled one.
    fn tool_calls(&self) -> Vec<(&str, &genehub_proto::ToolCallDetail)> {
        let mut seen: Vec<&str> = Vec::new();
        let mut latest: Vec<(&str, &genehub_proto::ToolCallDetail)> = Vec::new();
        for item in self.items() {
            let genehub_proto::TimelineItem::ToolCall {
                id, name, detail, ..
            } = item
            else {
                continue;
            };
            match seen.iter().position(|known| *known == id.as_str()) {
                Some(index) => latest[index] = (name.as_str(), detail),
                None => {
                    seen.push(id.as_str());
                    latest.push((name.as_str(), detail));
                }
            }
        }
        latest
    }

    /// The final text of every assistant bubble, in order.
    ///
    /// Items are upserts, so the last version of each id is the settled one.
    fn assistant_text(&self) -> String {
        let mut latest: Vec<(String, String)> = Vec::new();
        for item in self.items() {
            if let genehub_proto::TimelineItem::AssistantMessage { id, text } = item {
                match latest.iter_mut().find(|(seen, _)| seen == id) {
                    Some((_, value)) => *value = text.clone(),
                    None => latest.push((id.clone(), text.clone())),
                }
            }
        }
        latest
            .into_iter()
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join("")
    }

    fn completed(&self) -> bool {
        self.iter()
            .any(|event| matches!(event, SessionEvent::TurnCompleted { .. }))
    }

    fn canceled(&self) -> bool {
        self.iter()
            .any(|event| matches!(event, SessionEvent::TurnCanceled { .. }))
    }

    fn failure(&self) -> Option<&genehub_proto::TurnError> {
        self.iter().find_map(|event| match event {
            SessionEvent::TurnFailed { error, .. } => Some(error),
            _ => None,
        })
    }
}

/// Unwraps a reply into the variant a call is expected to return.
#[macro_export]
macro_rules! expect_reply {
    ($reply:expr, $variant:path) => {
        match $reply {
            $variant(value) => value,
            other => panic!("expected {}, got {other:?}", stringify!($variant)),
        }
    };
}

pub fn as_value(reply: &Reply) -> Value {
    serde_json::to_value(reply).unwrap_or(Value::Null)
}
