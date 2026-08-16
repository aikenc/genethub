use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use bytes::Bytes;
use genet_daemon_logic_api::{
    CapabilityEvent, CapabilityFailure, CapabilityFailureKind, CapabilityValue, RtcDescriptionKind,
    RtcRequest, MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::sync::{mpsc, Mutex, OwnedSemaphorePermit, RwLock, Semaphore};
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

use crate::failure;

const MAX_RTC_PEERS: usize = 32;
const GATHER_TIMEOUT: Duration = Duration::from_secs(12);

#[derive(Clone)]
pub struct RtcPeers {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    resources: RwLock<HashMap<u64, Arc<Resource>>>,
    slots: Arc<Semaphore>,
    events: mpsc::Sender<CapabilityEvent>,
}

struct Resource {
    connection: Arc<RTCPeerConnection>,
    channel: Mutex<Option<Arc<RTCDataChannel>>>,
    accepted_channel: AtomicBool,
    label: String,
    max_message_bytes: usize,
    _slot: OwnedSemaphorePermit,
}

impl RtcPeers {
    pub fn new(events: mpsc::Sender<CapabilityEvent>) -> Self {
        Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                resources: RwLock::new(HashMap::new()),
                slots: Arc::new(Semaphore::new(MAX_RTC_PEERS)),
                events,
            }),
        }
    }

    pub async fn execute(&self, request: RtcRequest) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            RtcRequest::Create {
                ice_servers,
                data_channel_label,
                max_message_bytes,
            } => {
                self.create(ice_servers, data_channel_label, max_message_bytes)
                    .await
            }
            RtcRequest::SetRemoteDescription {
                resource_id,
                kind,
                sdp,
            } => {
                if sdp.is_empty() || sdp.len() > 64 * 1024 {
                    return Err(failure(
                        CapabilityFailureKind::TooLarge,
                        "RTC description is empty or exceeds 64 KiB",
                    ));
                }
                let resource = self.resource(resource_id).await?;
                let description = match kind {
                    RtcDescriptionKind::Offer => RTCSessionDescription::offer(sdp),
                    RtcDescriptionKind::Answer => RTCSessionDescription::answer(sdp),
                }
                .map_err(rtc_failure)?;
                resource
                    .connection
                    .set_remote_description(description)
                    .await
                    .map_err(rtc_failure)?;
                Ok(CapabilityValue::Unit)
            }
            RtcRequest::CreateAnswer { resource_id } => {
                let resource = self.resource(resource_id).await?;
                let answer = resource
                    .connection
                    .create_answer(None)
                    .await
                    .map_err(rtc_failure)?;
                let mut gathering = resource.connection.gathering_complete_promise().await;
                resource
                    .connection
                    .set_local_description(answer)
                    .await
                    .map_err(rtc_failure)?;
                let _ = tokio::time::timeout(GATHER_TIMEOUT, gathering.recv()).await;
                let local = resource
                    .connection
                    .local_description()
                    .await
                    .ok_or_else(|| {
                        failure(
                            CapabilityFailureKind::Unavailable,
                            "RTC answer was not created",
                        )
                    })?;
                Ok(CapabilityValue::RtcDescription {
                    kind: RtcDescriptionKind::Answer,
                    sdp: local.sdp,
                })
            }
            RtcRequest::Send { resource_id, bytes } => {
                let resource = self.resource(resource_id).await?;
                if bytes.len() > resource.max_message_bytes {
                    return Err(failure(
                        CapabilityFailureKind::TooLarge,
                        "RTC message exceeds this peer's limit",
                    ));
                }
                let channel = resource.channel.lock().await.clone().ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::Conflict,
                        "RTC data channel is not open",
                    )
                })?;
                channel
                    .send(&Bytes::from(bytes))
                    .await
                    .map_err(rtc_failure)?;
                Ok(CapabilityValue::Unit)
            }
            RtcRequest::Close { resource_id } => {
                let resource = self.inner.resources.write().await.remove(&resource_id);
                if let Some(resource) = resource {
                    resource.connection.close().await.map_err(rtc_failure)?;
                }
                Ok(CapabilityValue::Unit)
            }
        }
    }

    async fn create(
        &self,
        ice_servers: Vec<String>,
        data_channel_label: String,
        max_message_bytes: u32,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        if data_channel_label.is_empty() || data_channel_label.len() > 256 {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "RTC data channel label is empty or too long",
            ));
        }
        let max_message_bytes = max_message_bytes as usize;
        if max_message_bytes == 0 || max_message_bytes > MAX_CAPABILITY_CHUNK_BYTES {
            return Err(failure(
                CapabilityFailureKind::TooLarge,
                "RTC message limit is empty or exceeds the capability chunk limit",
            ));
        }
        if ice_servers.len() > 16
            || ice_servers
                .iter()
                .any(|url| url.is_empty() || url.len() > 2048 || url.contains('\0'))
        {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "RTC ICE server list is malformed",
            ));
        }
        let slot =
            self.inner.slots.clone().try_acquire_owned().map_err(|_| {
                failure(CapabilityFailureKind::Unavailable, "RTC peer limit reached")
            })?;
        let connection = Arc::new(
            APIBuilder::new()
                .build()
                .new_peer_connection(RTCConfiguration {
                    ice_servers: if ice_servers.is_empty() {
                        Vec::new()
                    } else {
                        vec![RTCIceServer {
                            urls: ice_servers,
                            ..Default::default()
                        }]
                    },
                    ..Default::default()
                })
                .await
                .map_err(rtc_failure)?,
        );
        let resource_id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let resource = Arc::new(Resource {
            connection: connection.clone(),
            channel: Mutex::new(None),
            accepted_channel: AtomicBool::new(false),
            label: data_channel_label,
            max_message_bytes,
            _slot: slot,
        });
        self.inner
            .resources
            .write()
            .await
            .insert(resource_id, resource.clone());

        let weak = Arc::downgrade(&resource);
        let events = self.inner.events.clone();
        connection.on_data_channel(Box::new(move |channel| {
            let weak = weak.clone();
            let events = events.clone();
            Box::pin(async move {
                attach_channel(resource_id, weak, events, channel).await;
            })
        }));

        let inner = Arc::downgrade(&self.inner);
        connection.on_peer_connection_state_change(Box::new(move |state| {
            let inner = inner.clone();
            Box::pin(async move {
                if matches!(
                    state,
                    RTCPeerConnectionState::Failed
                        | RTCPeerConnectionState::Disconnected
                        | RTCPeerConnectionState::Closed
                ) {
                    close_from_callback(resource_id, inner, format!("{state:?}")).await;
                }
            })
        }));
        Ok(CapabilityValue::Resource { resource_id })
    }

    async fn resource(&self, resource_id: u64) -> Result<Arc<Resource>, CapabilityFailure> {
        self.inner
            .resources
            .read()
            .await
            .get(&resource_id)
            .cloned()
            .ok_or_else(|| {
                failure(
                    CapabilityFailureKind::NotFound,
                    format!("no RTC resource {resource_id}"),
                )
            })
    }

    pub async fn close_all(&self) {
        let resources = self
            .inner
            .resources
            .write()
            .await
            .drain()
            .map(|(_, resource)| resource)
            .collect::<Vec<_>>();
        for resource in resources {
            let _ = resource.connection.close().await;
        }
    }

    pub async fn count(&self) -> usize {
        self.inner.resources.read().await.len()
    }
}

async fn attach_channel(
    resource_id: u64,
    resource: Weak<Resource>,
    events: mpsc::Sender<CapabilityEvent>,
    channel: Arc<RTCDataChannel>,
) {
    let Some(resource) = resource.upgrade() else {
        let _ = channel.close().await;
        return;
    };
    if channel.label() != resource.label
        || !channel.ordered()
        || resource.accepted_channel.swap(true, Ordering::AcqRel)
    {
        let _ = channel.close().await;
        return;
    }
    let max_message_bytes = resource.max_message_bytes;
    let message_events = events.clone();
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        let events = message_events.clone();
        Box::pin(async move {
            if !message.is_string && message.data.len() <= max_message_bytes {
                let _ = events
                    .send(CapabilityEvent::RtcMessage {
                        resource_id,
                        bytes: message.data.to_vec(),
                    })
                    .await;
            }
        })
    }));
    let close_events = events.clone();
    channel.on_close(Box::new(move || {
        let events = close_events.clone();
        Box::pin(async move {
            let _ = events
                .send(CapabilityEvent::RtcClosed {
                    resource_id,
                    reason: "data channel closed".to_string(),
                })
                .await;
        })
    }));
    let open_events = events;
    channel.on_open(Box::new(move || {
        let events = open_events.clone();
        Box::pin(async move {
            let _ = events
                .send(CapabilityEvent::RtcOpened { resource_id })
                .await;
        })
    }));
    *resource.channel.lock().await = Some(channel);
}

async fn close_from_callback(resource_id: u64, inner: Weak<Inner>, reason: String) {
    let Some(inner) = inner.upgrade() else {
        return;
    };
    if inner.resources.write().await.remove(&resource_id).is_some() {
        let _ = inner
            .events
            .send(CapabilityEvent::RtcClosed {
                resource_id,
                reason,
            })
            .await;
    }
}

fn rtc_failure(error: impl std::fmt::Display) -> CapabilityFailure {
    failure(CapabilityFailureKind::Unavailable, error.to_string())
}
