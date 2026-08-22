//! The `rtc` import: one WebRTC data channel, and nothing about what it carries.
//!
//! ICE needs raw UDP sockets and a clock, DTLS needs both again, and SCTP is a
//! protocol with its own timers on top — none of which a component can drive.
//! So the connection lives here, in the shell, and stops at the connection: an
//! offer in, an answer out, ordered binary messages both ways. Everything the
//! product means by "a peer" — who may connect, what a message is, how long an
//! unauthenticated one may hold a slot — stays in the guest, next to the same
//! decisions for the relay path (`apps/daemon/src/dataplane/rtc.rs`).
//!
//! Non-blocking like `process` and `pty`: an import that awaited would suspend
//! the guest fiber and with it every other session.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use tokio::sync::mpsc;
use wasmtime::component::Resource;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::bindings::genehub::host::rtc as wit;

/// What the peer has sent and the guest has not taken yet, plus the two facts
/// the guest polls for. One lock: every one of these changes is a single step
/// of the same state machine, and a guest that saw `open` before the answer, or
/// a message after `closed`, would have to reason about an order nobody meant.
#[derive(Default)]
struct Shared {
    answer: Option<String>,
    state: State,
    inbound: VecDeque<Vec<u8>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum State {
    #[default]
    Connecting,
    Open,
    Closed,
}

pub struct RtcSession {
    shared: Arc<Mutex<Shared>>,
    outbound: mpsc::Sender<Vec<u8>>,
    connection: Arc<RTCPeerConnection>,
}

impl Shared {
    fn close(shared: &Arc<Mutex<Self>>) {
        let mut inner = shared.lock().unwrap();
        inner.state = State::Closed;
        // Nothing will read them now, and holding a peer's last burst until the
        // guest happens to drop the session is memory nobody asked for.
        inner.inbound.clear();
    }
}

impl RtcSession {
    async fn accept(offer: &str, config: &wit::Config) -> Result<Self, String> {
        let api = APIBuilder::new().build();
        let connection = Arc::new(
            api.new_peer_connection(RTCConfiguration {
                // One entry each, so a list with nothing in it is no servers
                // rather than one server with no address.
                ice_servers: config
                    .ice_servers
                    .iter()
                    .map(|url| RTCIceServer {
                        urls: vec![url.clone()],
                        ..Default::default()
                    })
                    .collect(),
                ..Default::default()
            })
            .await
            .map_err(|error| format!("creating the peer connection: {error}"))?,
        );

        let shared = Arc::new(Mutex::new(Shared::default()));
        let (outbound, sends) = mpsc::channel::<Vec<u8>>(config.queue_depth.max(1) as usize);
        Self::on_channel(&connection, &shared, config, sends);
        Self::on_state(&connection, &shared);

        connection
            .set_remote_description(
                RTCSessionDescription::offer(offer.to_string())
                    .map_err(|error| format!("reading the offer: {error}"))?,
            )
            .await
            .map_err(|error| format!("taking the offer: {error}"))?;
        let answer = connection
            .create_answer(None)
            .await
            .map_err(|error| format!("answering: {error}"))?;
        let mut gathered = connection.gathering_complete_promise().await;
        connection
            .set_local_description(answer)
            .await
            .map_err(|error| format!("keeping the answer: {error}"))?;

        // Gathering is a network wait, so it happens behind the guest rather
        // than inside this call: `answer` is `none` until it finishes.
        let gathering_shared = shared.clone();
        let gathering_connection = connection.clone();
        let patience = std::time::Duration::from_millis(config.gather_timeout_ms.max(1) as u64);
        tokio::spawn(async move {
            let _ = tokio::time::timeout(patience, gathered.recv()).await;
            match gathering_connection.local_description().await {
                // Whatever was gathered by now is what the peer gets; a
                // half-gathered answer still connects on a local network.
                Some(local) => gathering_shared.lock().unwrap().answer = Some(local.sdp),
                None => Shared::close(&gathering_shared),
            }
        });

        Ok(RtcSession {
            shared,
            outbound,
            connection,
        })
    }

    /// The peer may open any channel it likes; exactly one label is answered.
    fn on_channel(
        connection: &Arc<RTCPeerConnection>,
        shared: &Arc<Mutex<Shared>>,
        config: &wit::Config,
        sends: mpsc::Receiver<Vec<u8>>,
    ) {
        let label = config.channel_label.clone();
        let max_message = config.max_message_bytes as usize;
        let depth = config.queue_depth.max(1) as usize;
        let shared = shared.clone();
        let sends = Arc::new(tokio::sync::Mutex::new(Some(sends)));
        let owner = Arc::downgrade(connection);
        connection.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
            let shared = shared.clone();
            let label = label.clone();
            let sends = sends.clone();
            let owner = owner.clone();
            Box::pin(async move {
                let taken = shared.lock().unwrap().state != State::Connecting;
                if channel.label() != label || !channel.ordered() || taken {
                    let _ = channel.close().await;
                    return;
                }
                let Some(sends) = sends.lock().await.take() else {
                    let _ = channel.close().await;
                    return;
                };
                attach(channel, shared, sends, max_message, depth, owner);
            })
        }));
    }

    fn on_state(connection: &Arc<RTCPeerConnection>, shared: &Arc<Mutex<Shared>>) {
        let shared = shared.clone();
        connection.on_peer_connection_state_change(Box::new(move |state| {
            let shared = shared.clone();
            Box::pin(async move {
                if matches!(
                    state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    Shared::close(&shared);
                }
            })
        }));
    }
}

/// Wires the one accepted channel to the two queues the guest polls.
fn attach(
    channel: Arc<RTCDataChannel>,
    shared: Arc<Mutex<Shared>>,
    mut sends: mpsc::Receiver<Vec<u8>>,
    max_message: usize,
    depth: usize,
    owner: std::sync::Weak<RTCPeerConnection>,
) {
    let inbound = shared.clone();
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let shared = inbound.clone();
        Box::pin(async move {
            // A text frame is not what this carries, and an oversized one is
            // not a frame the guest would accept either. Dropping is the same
            // answer the guest gives, one hop earlier.
            if message.is_string || message.data.len() > max_message {
                return;
            }
            let mut state = shared.lock().unwrap();
            if state.inbound.len() >= depth {
                state.inbound.pop_front();
            }
            state.inbound.push_back(message.data.to_vec());
        })
    }));

    let closing = shared.clone();
    let closing_owner = owner.clone();
    channel.on_close(Box::new(move || {
        let shared = closing.clone();
        let owner = closing_owner.clone();
        Box::pin(async move {
            Shared::close(&shared);
            if let Some(connection) = owner.upgrade() {
                let _ = connection.close().await;
            }
        })
    }));

    let opened = shared.clone();
    let sender = channel.clone();
    channel.on_open(Box::new(move || {
        let shared = opened.clone();
        Box::pin(async move {
            shared.lock().unwrap().state = State::Open;
            tokio::spawn(async move {
                while let Some(record) = sends.recv().await {
                    if sender.send(&Bytes::from(record)).await.is_err() {
                        break;
                    }
                }
                Shared::close(&shared);
                let _ = sender.close().await;
            });
        })
    }));
}

impl wit::HostSession for crate::load::Host {
    async fn answer(&mut self, this: Resource<RtcSession>) -> Option<String> {
        let session = self.table.get(&this).ok()?;
        session.shared.lock().unwrap().answer.clone()
    }

    async fn current(&mut self, this: Resource<RtcSession>) -> wit::State {
        let Ok(session) = self.table.get(&this) else {
            return wit::State::Closed;
        };
        match session.shared.lock().unwrap().state {
            State::Connecting => wit::State::Connecting,
            State::Open => wit::State::Open,
            State::Closed => wit::State::Closed,
        }
    }

    async fn receive(&mut self, this: Resource<RtcSession>) -> Option<Vec<u8>> {
        let session = self.table.get(&this).ok()?;
        let message = session.shared.lock().unwrap().inbound.pop_front();
        message
    }

    async fn send(&mut self, this: Resource<RtcSession>, data: Vec<u8>) -> Result<(), String> {
        let session = self.table.get(&this).map_err(|error| error.to_string())?;
        match session.outbound.try_send(data) {
            Ok(()) => Ok(()),
            // The queue is the whole of the backpressure story, and a record
            // the guest cannot place is a record it has to be told about: this
            // carries framed records, so a silently dropped one is a stream
            // the peer can no longer parse.
            Err(mpsc::error::TrySendError::Full(_)) => Err("the send queue is full".into()),
            Err(mpsc::error::TrySendError::Closed(_)) => Err("the channel is closed".into()),
        }
    }

    async fn drop(&mut self, this: Resource<RtcSession>) -> wasmtime::Result<()> {
        if let Ok(session) = self.table.delete(this) {
            // Hanging up is asynchronous, and this import is not: the guest has
            // already let go, so the close runs on its own.
            tokio::spawn(async move {
                let _ = session.connection.close().await;
            });
        }
        Ok(())
    }
}

impl wit::Host for crate::load::Host {
    async fn accept(
        &mut self,
        offer: String,
        config: wit::Config,
    ) -> Result<Resource<RtcSession>, String> {
        let session = RtcSession::accept(&offer, &config).await?;
        self.table.push(session).map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn config(label: &str) -> wit::Config {
        wit::Config {
            // No STUN: both ends are on this machine, so host candidates are
            // the only ones that mean anything and asking the internet where
            // we are would only make the test slower and less certain.
            ice_servers: Vec::new(),
            channel_label: label.to_string(),
            gather_timeout_ms: 5_000,
            max_message_bytes: 64 * 1024,
            queue_depth: 8,
        }
    }

    /// A real peer with a real stack, because what is worth proving is that an
    /// offer from one is answered by this and that bytes cross afterwards.
    async fn offering_peer(label: &str) -> (Arc<RTCPeerConnection>, Arc<RTCDataChannel>, String) {
        let peer = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration::default())
                .await
                .expect("a peer connection"),
        );
        let channel = peer
            .create_data_channel(label, None)
            .await
            .expect("a data channel");
        let offer = peer.create_offer(None).await.expect("an offer");
        let mut gathered = peer.gathering_complete_promise().await;
        peer.set_local_description(offer).await.expect("kept offer");
        let _ = tokio::time::timeout(Duration::from_secs(5), gathered.recv()).await;
        let sdp = peer
            .local_description()
            .await
            .expect("a gathered offer")
            .sdp;
        (peer, channel, sdp)
    }

    async fn wait_for<T>(mut probe: impl FnMut() -> Option<T>) -> T {
        for _ in 0..600 {
            if let Some(value) = probe() {
                return value;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        panic!("the connection never got there");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn an_offer_is_answered_and_the_agreed_channel_carries_both_ways() {
        let label = "genehub-data-v3";
        let (peer, channel, offer) = offering_peer(label).await;
        let (arrived_tx, mut arrived) = mpsc::channel::<Vec<u8>>(4);
        channel.on_message(Box::new(move |message: DataChannelMessage| {
            let arrived = arrived_tx.clone();
            Box::pin(async move {
                let _ = arrived.send(message.data.to_vec()).await;
            })
        }));

        let session = RtcSession::accept(&offer, &config(label))
            .await
            .expect("the offer is answered");
        let answer = wait_for(|| session.shared.lock().unwrap().answer.clone()).await;
        peer.set_remote_description(
            RTCSessionDescription::answer(answer).expect("a usable answer"),
        )
        .await
        .expect("the answer is taken");

        wait_for(|| (session.shared.lock().unwrap().state == State::Open).then_some(())).await;

        channel
            .send(&Bytes::from_static(b"from the peer"))
            .await
            .expect("the peer can send");
        let received = wait_for(|| session.shared.lock().unwrap().inbound.pop_front()).await;
        assert_eq!(received, b"from the peer");

        session
            .outbound
            .send(b"from the daemon".to_vec())
            .await
            .expect("the queue takes it");
        let echoed = tokio::time::timeout(Duration::from_secs(10), arrived.recv())
            .await
            .expect("the peer hears back")
            .expect("a message");
        assert_eq!(echoed, b"from the daemon");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_channel_by_another_name_is_closed_unread() {
        let (peer, channel, offer) = offering_peer("something-else").await;
        let session = RtcSession::accept(&offer, &config("genehub-data-v3"))
            .await
            .expect("the offer is answered");
        let answer = wait_for(|| session.shared.lock().unwrap().answer.clone()).await;
        peer.set_remote_description(
            RTCSessionDescription::answer(answer).expect("a usable answer"),
        )
        .await
        .expect("the answer is taken");

        // Wait for the transport itself to come up: the point is that a
        // connection which succeeded in every other way still did not adopt a
        // channel nobody agreed to, which is only meaningful once it is up.
        wait_for(|| (peer.connection_state() == RTCPeerConnectionState::Connected).then_some(()))
            .await;
        let _ = channel.send(&Bytes::from_static(b"unwanted")).await;
        tokio::time::sleep(Duration::from_millis(500)).await;

        let shared = session.shared.lock().unwrap();
        assert_ne!(
            shared.state,
            State::Open,
            "a channel nobody agreed to must not count as the connection"
        );
        assert!(
            shared.inbound.is_empty(),
            "a refused channel must not be able to queue anything"
        );
    }
}
