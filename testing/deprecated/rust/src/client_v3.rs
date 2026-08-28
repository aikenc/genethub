//! Protocol-v3 test client: real WebSocket, E2EE records and logical streams.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use futures_util::{SinkExt, StreamExt};
use genehub_proto::{
    PeerAuth, PeerHello, PeerWelcome, Reply, Request, SequencedEvent, ServerFrame, SessionEvent,
};
use genet_daemon::dataplane::client::ClientEndpoint;
use serde_json::Value;
use tokio::sync::{mpsc, Mutex};
use tokio_tungstenite::tungstenite::Message;

pub const WAIT_TIMEOUT: Duration = Duration::from_secs(180);
const EVENT_MESSAGE_BYTES: usize = 1024 * 1024;

pub struct Client {
    endpoint: ClientEndpoint,
    pub events: Mutex<mpsc::UnboundedReceiver<SequencedEvent>>,
    pub pty: Mutex<mpsc::UnboundedReceiver<(String, String)>>,
    pub notices: Mutex<mpsc::UnboundedReceiver<String>>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

impl Client {
    pub async fn connect_loopback(daemon: &genet_daemon::Daemon) -> Result<Self> {
        let admission = daemon.websocket_admission();
        let (mut socket, _) = tokio_tungstenite::connect_async(&admission.url).await?;
        let nonce = genet_daemon::devices::random_token();
        let context = "loopback";
        let hello = PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: "genehub-testing".into(),
            auth: PeerAuth::Loopback {
                context: context.into(),
                nonce: nonce.clone(),
                proof: genet_daemon::channel_auth::client_proof(
                    &admission.server_proof,
                    context,
                    &nonce,
                ),
            },
            rtc_supported: false,
            max_bulk_stream_window_bytes: None,
        };
        socket
            .send(Message::Binary(serde_json::to_vec(&hello)?))
            .await?;
        let welcome = tokio::time::timeout(Duration::from_secs(10), socket.next())
            .await
            .context("peer handshake timed out")?
            .ok_or_else(|| anyhow!("daemon closed during peer handshake"))??;
        let Message::Binary(welcome) = welcome else {
            bail!("daemon returned a non-binary peer welcome");
        };
        let welcome: PeerWelcome = serde_json::from_slice(&welcome)?;
        if welcome.version != genehub_proto::DATA_PLANE_VERSION {
            bail!("daemon returned a different data-plane version");
        }
        genet_daemon::channel_auth::verify_proof(
            &genet_daemon::channel_auth::server_proof(
                &admission.server_proof,
                context,
                &nonce,
                &welcome.server_nonce,
            ),
            &welcome.proof,
        )?;
        let key = genet_daemon::channel_auth::derive_key(
            &admission.server_proof,
            context,
            &nonce,
            &welcome.server_nonce,
        );

        let (mut sink, mut source) = socket.split();
        let (inbound, mut outbound, carrier) =
            genet_daemon::dataplane::endpoint::carrier_channels();
        let writer = tokio::spawn(async move {
            while let Some(record) = outbound.recv().await {
                if sink.send(Message::Binary(record)).await.is_err() {
                    break;
                }
            }
        });
        let reader = tokio::spawn(async move {
            while let Some(Ok(message)) = source.next().await {
                match message {
                    Message::Binary(record)
                        if record.len() <= genehub_proto::MAX_DATA_FRAME_BYTES =>
                    {
                        if inbound.send(record.to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => continue,
                    _ => break,
                }
            }
        });
        let (endpoint, endpoint_task) = ClientEndpoint::start(key, carrier);
        let endpoint_monitor = tokio::spawn(async move {
            let _ = endpoint_task.await;
        });

        let (events_rx, pty_rx, notice_rx, event_reader) = Self::read_events(&endpoint).await?;

        Ok(Self {
            endpoint,
            events: Mutex::new(events_rx),
            pty: Mutex::new(pty_rx),
            notices: Mutex::new(notice_rx),
            tasks: vec![writer, reader, endpoint_monitor, event_reader],
        })
    }

    #[allow(clippy::type_complexity)]
    async fn read_events(
        endpoint: &ClientEndpoint,
    ) -> Result<(
        mpsc::UnboundedReceiver<SequencedEvent>,
        mpsc::UnboundedReceiver<(String, String)>,
        mpsc::UnboundedReceiver<String>,
        tokio::task::JoinHandle<()>,
    )> {
        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let (pty_tx, pty_rx) = mpsc::unbounded_channel();
        let (notice_tx, notice_rx) = mpsc::unbounded_channel();
        let mut stream = endpoint
            .open_stream("events", Value::Null, Vec::new(), None)
            .await?;
        let head = stream.response_head().await?;
        if head.status != 200 || head.error.is_some() {
            bail!("daemon refused the event stream");
        }
        let event_reader = tokio::spawn(async move {
            let mut buffered = Vec::<u8>::new();
            while let Some(Ok(chunk)) = stream.next_chunk().await {
                buffered.extend_from_slice(&chunk);
                loop {
                    if buffered.len() < 4 {
                        break;
                    }
                    let length = u32::from_be_bytes(buffered[..4].try_into().unwrap()) as usize;
                    if length == 0 || length > EVENT_MESSAGE_BYTES {
                        return;
                    }
                    if buffered.len() < 4 + length {
                        break;
                    }
                    let decoded = serde_json::from_slice::<ServerFrame>(&buffered[4..4 + length]);
                    buffered.drain(..4 + length);
                    let Ok(frame) = decoded else {
                        return;
                    };
                    match frame {
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
                        ServerFrame::UpdateDownloadChanged { .. }
                        | ServerFrame::BackgroundProcesses { .. } => {}
                        ServerFrame::Desync { session_id, missed } => {
                            panic!("the daemon dropped {missed} events for {session_id}");
                        }
                    }
                }
            }
        });
        Ok((events_rx, pty_rx, notice_rx, event_reader))
    }

    /// Connects as a paired device, over the same peer code path a relay would
    /// carry but without one in the way.
    ///
    /// The carrier is the only thing simulated. The handshake, the device
    /// authentication, the grant gate and the event fanout are the daemon's
    /// own, which is the whole point: a test that stubbed those would prove
    /// something about the stub.
    pub async fn connect_as_device(
        daemon: &genet_daemon::Daemon,
        credential: &genehub_proto::DeviceCredential,
    ) -> Result<Self> {
        let nonce = challenge();
        let context = genet_daemon::channel_auth::device_context(&credential.device_id);
        let hello = PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: "genehub-testing-device".into(),
            auth: PeerAuth::Device {
                device_id: credential.device_id.clone(),
                nonce: nonce.clone(),
                proof: genet_daemon::channel_auth::client_proof(
                    &credential.secret,
                    &context,
                    &nonce,
                ),
            },
            rtc_supported: false,
            max_bulk_stream_window_bytes: None,
        };
        Self::over_carrier(daemon, hello, &credential.secret, &context, &nonce).await
    }

    /// Connects with a pairing invitation, the way a device that owns nothing
    /// yet has to start.
    pub async fn connect_with_invite(
        daemon: &genet_daemon::Daemon,
        code: &str,
    ) -> Result<(Self, String)> {
        let (invite_id, secret) = code
            .split_once('.')
            .ok_or_else(|| anyhow!("a pairing code is `<inviteId>.<secret>`"))?;
        let nonce = challenge();
        let context = format!("invite:{invite_id}");
        let hello = PeerHello {
            version: genehub_proto::DATA_PLANE_VERSION,
            client_name: "genehub-testing-invite".into(),
            auth: PeerAuth::Invite {
                invite_id: invite_id.to_string(),
                nonce: nonce.clone(),
                proof: genet_daemon::channel_auth::client_proof(secret, &context, &nonce),
            },
            rtc_supported: false,
            max_bulk_stream_window_bytes: None,
        };
        let client = Self::over_carrier(daemon, hello, secret, &context, &nonce).await?;
        Ok((client, invite_id.to_string()))
    }

    async fn over_carrier(
        daemon: &genet_daemon::Daemon,
        hello: PeerHello,
        secret: &str,
        context: &str,
        nonce: &str,
    ) -> Result<Self> {
        let accepted = genet_daemon::dataplane::handshake::accept(
            &daemon.state,
            genehub_proto::TransportKind::Forwarded,
            genet_daemon::transport::admission::Admission::DeviceRequired,
            &serde_json::to_vec(&hello)?,
            None,
            None,
        )?;
        genet_daemon::channel_auth::verify_proof(
            &genet_daemon::channel_auth::server_proof(
                secret,
                context,
                nonce,
                &accepted.welcome.server_nonce,
            ),
            &accepted.welcome.proof,
        )?;
        let key = genet_daemon::channel_auth::derive_key(
            secret,
            context,
            nonce,
            &accepted.welcome.server_nonce,
        );

        let (to_client, mut from_daemon, daemon_carrier) =
            genet_daemon::dataplane::endpoint::carrier_channels();
        let (to_daemon, mut from_client, client_carrier) =
            genet_daemon::dataplane::endpoint::carrier_channels();
        let state = daemon.state.clone();
        let access = accepted.access.clone();
        let daemon_key = key.clone();
        let peer = tokio::spawn(async move {
            let _ = genet_daemon::dataplane::endpoint::serve(
                state,
                daemon_key,
                access,
                daemon_carrier,
                genet_daemon::dataplane::endpoint::CarrierKind::Fabric,
            )
            .await;
        });
        let uplink = tokio::spawn(async move {
            while let Some(record) = from_client.recv().await {
                if to_client.send(record).await.is_err() {
                    return;
                }
            }
        });
        let downlink = tokio::spawn(async move {
            while let Some(record) = from_daemon.recv().await {
                if to_daemon.send(record).await.is_err() {
                    return;
                }
            }
        });
        let (endpoint, endpoint_task) = ClientEndpoint::start(key, client_carrier);
        let endpoint_monitor = tokio::spawn(async move {
            let _ = endpoint_task.await;
        });
        let (events_rx, pty_rx, notice_rx, event_reader) = Self::read_events(&endpoint).await?;
        Ok(Self {
            endpoint,
            events: Mutex::new(events_rx),
            pty: Mutex::new(pty_rx),
            notices: Mutex::new(notice_rx),
            tasks: vec![peer, uplink, downlink, endpoint_monitor, event_reader],
        })
    }

    pub async fn call(&self, request: Request) -> Result<Reply> {
        let response = tokio::time::timeout(
            WAIT_TIMEOUT,
            self.endpoint
                .exchange("rpc", Value::Null, serde_json::to_vec(&request)?, None),
        )
        .await
        .context("timed out waiting for a reply")??;
        if let Some(error) = response.head.error {
            bail!("{:?}: {}", error.code, error.message);
        }
        if response.head.status != 200 {
            bail!("daemon returned status {}", response.head.status);
        }
        Ok(serde_json::from_slice(&response.body)?)
    }

    /// Asks for a file's bytes the way the workbench does: a stream of its own,
    /// not an rpc. Returns the whole response head, because a refusal by the
    /// gate and a refusal by the preview itself share a status code and differ
    /// only in what they say.
    pub async fn preview(
        &self,
        workspace_id: &str,
        path: &str,
    ) -> Result<(genehub_proto::ExchangeResponseHead, Vec<u8>)> {
        let response = tokio::time::timeout(
            WAIT_TIMEOUT,
            self.endpoint.exchange(
                "asset.preview",
                serde_json::json!({
                    "source": { "kind": "workspaceFile", "workspaceHandle": workspace_id, "path": path }
                }),
                Vec::new(),
                None,
            ),
        )
        .await
        .context("timed out waiting for a preview")??;
        Ok((response.head, response.body))
    }

    /// Runs a command and collects everything it produced.
    ///
    /// Returns the response head beside the frames, because a refusal arrives
    /// there and a caller has to be able to tell "this machine would not run
    /// it" from "it ran and printed nothing".
    pub async fn run_command(
        &self,
        request: genehub_proto::ShellRunRequest,
    ) -> Result<(
        genehub_proto::ExchangeResponseHead,
        Vec<genehub_proto::ShellFrame>,
    )> {
        self.run_command_with_input(request, Vec::new()).await
    }

    /// The body is the command's standard input.
    pub async fn run_command_with_input(
        &self,
        request: genehub_proto::ShellRunRequest,
        stdin: Vec<u8>,
    ) -> Result<(
        genehub_proto::ExchangeResponseHead,
        Vec<genehub_proto::ShellFrame>,
    )> {
        let mut stream = self
            .endpoint
            .open_stream("shell.run", serde_json::to_value(&request)?, stdin, None)
            .await?;
        let head = tokio::time::timeout(WAIT_TIMEOUT, stream.response_head())
            .await
            .context("timed out waiting for the command to start")??;
        let mut frames = Vec::new();
        if head.status != 200 {
            return Ok((head, frames));
        }
        let mut buffered = Vec::<u8>::new();
        loop {
            while buffered.len() >= 4 {
                let length = u32::from_be_bytes(buffered[..4].try_into().unwrap()) as usize;
                if buffered.len() < 4 + length {
                    break;
                }
                frames.push(serde_json::from_slice(&buffered[4..4 + length])?);
                buffered.drain(..4 + length);
            }
            if matches!(frames.last(), Some(genehub_proto::ShellFrame::Exit { .. })) {
                return Ok((head, frames));
            }
            match tokio::time::timeout(WAIT_TIMEOUT, stream.next_chunk()).await? {
                Some(Ok(chunk)) => buffered.extend_from_slice(&chunk),
                Some(Err(error)) => return Err(error),
                // No exit frame and nothing more coming: the caller needs to
                // see that as different from a command that finished.
                None => return Ok((head, frames)),
            }
        }
    }

    pub async fn expect_error(&self, request: Request) -> String {
        match self.call(request).await {
            Ok(reply) => panic!("expected a failure, got {reply:?}"),
            Err(error) => error.to_string(),
        }
    }

    /// Kept as a semantic test helper; v3 already completed the peer handshake
    /// before this client was returned, so it reads the encrypted identity.
    pub async fn hello(&self, _name: &str) -> Result<Reply> {
        self.call(Request::ConnectionIdentity).await
    }

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
        for task in self.tasks {
            task.abort();
        }
    }
}

/// The 16 random bytes a peer challenge has to be, in lowercase hexadecimal.
fn challenge() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

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
