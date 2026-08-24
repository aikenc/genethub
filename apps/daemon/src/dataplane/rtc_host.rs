//! The native carrier for `rtc`: `webrtc-rs` in this process.
//!
//! Only the connection differs from `rtc_guest.rs`; the policy above it is the
//! same and lives in the parent module.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use anyhow::{anyhow, Context, Result};
use bytes::Bytes;
use genehub_proto::{
    ErrorCode, ExchangeResponseHead, RtcNegotiationRequest, RtcNegotiationResponse, TransportKind,
};
use tokio::sync::{mpsc, watch, Mutex, OwnedSemaphorePermit, Semaphore};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::dataplane::endpoint::{self, PeerAccess, PeerServices, ServerStream};
use crate::dataplane::handshake;
use crate::transport::admission::Admission;

use super::{
    DATA_CHANNEL_LABEL, MAX_RTC_PEERS, RTC_ADMISSION_LIFETIME, RTC_CHANNEL_QUEUE,
    RTC_GATHER_TIMEOUT, RTC_HELLO_TIMEOUT, RTC_SIGNAL_BYTES, STUN_SERVER,
};

struct RtcPeer {
    _connection: Arc<RTCPeerConnection>,
    _slot: OwnedSemaphorePermit,
}

type Registry = Arc<Mutex<HashMap<String, RtcPeer>>>;
static RTC_PEERS: OnceLock<Registry> = OnceLock::new();
static RTC_SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();

fn peers() -> &'static Registry {
    RTC_PEERS.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn slots() -> &'static Arc<Semaphore> {
    RTC_SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_RTC_PEERS)))
}

pub(crate) async fn handle(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    match negotiate(stream, services).await {
        Ok(()) => Ok(()),
        Err(error) => {
            tracing::debug!(%error, "RTC negotiation refused");
            endpoint::send_error(
                stream,
                503,
                ErrorCode::Unsupported,
                "a direct RTC channel could not be established",
            )
            .await
        }
    }
}

async fn negotiate(stream: &mut ServerStream, services: &PeerServices) -> Result<()> {
    let body = stream.read_body(RTC_SIGNAL_BYTES).await?;
    let request: RtcNegotiationRequest =
        serde_json::from_slice(&body).context("invalid RTC negotiation request")?;
    if request.sdp.is_empty() || request.sdp.len() > RTC_SIGNAL_BYTES {
        anyhow::bail!("invalid RTC offer size");
    }
    let slot = slots()
        .clone()
        .try_acquire_owned()
        .map_err(|_| anyhow!("RTC peer limit reached"))?;

    let capability_id = format!("rtc_{}", crate::devices::random_token());
    let secret = crate::devices::random_token();
    let admission = Admission::Rtc {
        capability_id: capability_id.clone(),
        secret: secret.clone(),
        expires_at: Instant::now() + RTC_ADMISSION_LIFETIME,
    };
    let inherited = services.access.clone();
    let state = services.state.clone();

    let api = APIBuilder::new().build();
    let connection = Arc::new(
        api.new_peer_connection(RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec![STUN_SERVER.to_string()],
                ..Default::default()
            }],
            ..Default::default()
        })
        .await?,
    );

    let accepted_channel = Arc::new(AtomicBool::new(false));
    let authenticated = Arc::new(AtomicBool::new(false));
    let authenticated_for_channel = authenticated.clone();
    let connection_for_channel = Arc::downgrade(&connection);
    let registry_key = capability_id.clone();
    connection.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
        let state = state.clone();
        let inherited = inherited.clone();
        let admission = admission.clone();
        let accepted_channel = accepted_channel.clone();
        let authenticated = authenticated_for_channel.clone();
        let connection = connection_for_channel.clone();
        let registry_key = registry_key.clone();
        Box::pin(async move {
            if channel.label() != DATA_CHANNEL_LABEL
                || !channel.ordered()
                || accepted_channel.swap(true, Ordering::AcqRel)
            {
                let _ = channel.close().await;
                remove_and_close(&registry_key, connection).await;
                return;
            }
            attach_channel(
                channel,
                state,
                inherited,
                admission,
                authenticated,
                connection,
                registry_key,
            );
        })
    }));

    let registry_key = capability_id.clone();
    let connection_for_state = Arc::downgrade(&connection);
    connection.on_peer_connection_state_change(Box::new(move |state| {
        let registry_key = registry_key.clone();
        let connection = connection_for_state.clone();
        Box::pin(async move {
            match state {
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Disconnected => {
                    remove_and_close(&registry_key, connection).await;
                }
                RTCPeerConnectionState::Closed => {
                    peers().lock().await.remove(&registry_key);
                }
                _ => {}
            }
        })
    }));

    connection
        .set_remote_description(RTCSessionDescription::offer(request.sdp)?)
        .await?;
    let answer = connection.create_answer(None).await?;
    let mut gathering = connection.gathering_complete_promise().await;
    connection.set_local_description(answer).await?;
    let _ = tokio::time::timeout(RTC_GATHER_TIMEOUT, gathering.recv()).await;
    let local = connection
        .local_description()
        .await
        .ok_or_else(|| anyhow!("RTC answer was not created"))?;

    peers().lock().await.insert(
        capability_id.clone(),
        RtcPeer {
            _connection: connection.clone(),
            _slot: slot,
        },
    );
    let expiry_key = capability_id.clone();
    let expiry_connection = Arc::downgrade(&connection);
    let expiry_authenticated = authenticated.clone();
    tokio::spawn(async move {
        tokio::time::sleep(RTC_ADMISSION_LIFETIME + Duration::from_secs(2)).await;
        if !expiry_authenticated.load(Ordering::Acquire) {
            remove_and_close(&expiry_key, expiry_connection).await;
        }
    });
    let response = serde_json::to_vec(&RtcNegotiationResponse {
        sdp: local.sdp,
        capability_id,
        secret,
    })?;
    stream
        .respond(&ExchangeResponseHead {
            status: 200,
            metadata: serde_json::Value::Null,
            body_length: Some(response.len() as u64),
            error: None,
        })
        .await?;
    stream.write(&response).await?;
    stream.finish().await
}

fn attach_channel(
    channel: Arc<RTCDataChannel>,
    state: crate::state::Shared,
    inherited: PeerAccess,
    admission: Admission,
    authenticated: Arc<AtomicBool>,
    connection: std::sync::Weak<RTCPeerConnection>,
    registry_key: String,
) {
    let (messages_tx, messages_rx) = mpsc::channel::<Vec<u8>>(RTC_CHANNEL_QUEUE);
    let (closed_tx, closed_rx) = watch::channel(false);
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let messages = messages_tx.clone();
        Box::pin(async move {
            if message.is_string || message.data.len() > genehub_proto::MAX_DATA_FRAME_BYTES {
                return;
            }
            let _ = messages.send(message.data.to_vec()).await;
        })
    }));
    channel.on_close(Box::new(move || {
        let closed = closed_tx.clone();
        let connection = connection.clone();
        let registry_key = registry_key.clone();
        Box::pin(async move {
            let _ = closed.send(true);
            remove_and_close(&registry_key, connection).await;
        })
    }));
    let open_channel = channel.clone();
    channel.on_open(Box::new(move || {
        Box::pin(async move {
            tokio::spawn(async move {
                if let Err(error) = serve_channel(
                    open_channel,
                    messages_rx,
                    closed_rx,
                    state,
                    inherited,
                    admission,
                    authenticated,
                )
                .await
                {
                    tracing::debug!(%error, "RTC data channel stopped");
                }
            });
        })
    }));
}

async fn serve_channel(
    channel: Arc<RTCDataChannel>,
    mut messages: mpsc::Receiver<Vec<u8>>,
    mut closed: watch::Receiver<bool>,
    state: crate::state::Shared,
    inherited: PeerAccess,
    admission: Admission,
    authenticated: Arc<AtomicBool>,
) -> Result<()> {
    let hello = tokio::select! {
        hello = tokio::time::timeout(RTC_HELLO_TIMEOUT, messages.recv()) => {
            hello.map_err(|_| anyhow!("RTC peer hello timed out"))?
                .ok_or_else(|| anyhow!("RTC data channel closed before hello"))?
        }
        _ = closed.changed() => return Err(anyhow!("RTC data channel closed before hello")),
    };
    let mut accepted = handshake::accept(
        &state,
        TransportKind::Forwarded,
        admission.clone(),
        &hello,
        inherited.workspace_id.clone(),
        inherited.workspace_handle.clone(),
    )?;
    // The short-lived RTC secret is a transport upgrade, not new authority.
    // Preserve the authenticated base peer's device and workspace scope.
    accepted.access = PeerAccess {
        transport: TransportKind::Forwarded,
        ..inherited
    };
    channel
        .send(&Bytes::from(serde_json::to_vec(&accepted.welcome)?))
        .await?;
    authenticated.store(true, Ordering::Release);

    let (inbound, mut outbound, carrier) = endpoint::carrier_channels();
    let write_channel = channel.clone();
    let mut writer = tokio::spawn(async move {
        while let Some(record) = outbound.recv().await {
            write_channel.send(&Bytes::from(record)).await?;
        }
        Result::<()>::Ok(())
    });
    let mut forward = tokio::spawn(async move {
        while let Some(record) = messages.recv().await {
            if inbound.send(record).await.is_err() {
                break;
            }
        }
    });
    let mut endpoint = tokio::spawn(endpoint::serve(
        state,
        accepted.key,
        accepted.access,
        carrier,
        endpoint::CarrierKind::Rtc,
    ));

    tokio::select! {
        result = &mut endpoint => result.context("RTC endpoint task stopped")??,
        result = &mut writer => result.context("RTC writer task stopped")??,
        _ = &mut forward => {},
        _ = closed.changed() => {},
    }
    endpoint.abort();
    writer.abort();
    forward.abort();
    let _ = channel.close().await;
    Ok(())
}

async fn remove_and_close(registry_key: &str, connection: std::sync::Weak<RTCPeerConnection>) {
    let connection = connection.upgrade();
    peers().lock().await.remove(registry_key);
    if let Some(connection) = connection {
        let _ = connection.close().await;
    }
}
