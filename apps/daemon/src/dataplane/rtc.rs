//! Endpoint-neutral E2EE RTC: the policy, and two ways to carry it.
//!
//! A viewer that can reach this machine directly should not pay for the relay,
//! so a peer already authenticated over the baseline may ask for one RTC data
//! channel and move onto it. What it gets is the same carrier, the same
//! handshake, and the same authority it already had.
//!
//! The connection under it is native either way — ICE is raw UDP with timers of
//! its own. A native daemon drives `webrtc-rs` itself (`rtc_host.rs`); the
//! component asks the shell for the same thing over `genehub:host/rtc` and
//! keeps every decision on this side (`rtc_guest.rs`). What the two share is
//! here, so "how long may a stranger hold a slot" has one answer per product
//! rather than one per build.

use std::time::Duration;

/// The largest signalling body either side will read: an offer is a page of
/// SDP, not a payload.
pub(crate) const RTC_SIGNAL_BYTES: usize = 64 * 1024;
/// How long the capability handed back with the answer stays usable. The peer
/// has to present it on the channel it opens, so this is how long an unproven
/// connection may exist at all.
pub(crate) const RTC_ADMISSION_LIFETIME: Duration = Duration::from_secs(30);
/// How long to gather candidates before answering with what there is.
pub(crate) const RTC_GATHER_TIMEOUT: Duration = Duration::from_secs(12);
/// Records held for the endpoint in either direction. Small: this is a
/// backpressure point, not a buffer.
pub(crate) const RTC_CHANNEL_QUEUE: usize = 16;
/// How many peers may hold a direct channel at once.
pub(crate) const MAX_RTC_PEERS: usize = 32;
/// The one channel a peer may open. Ordered, binary, and named for the wire
/// version it carries.
pub(crate) const DATA_CHANNEL_LABEL: &str = "genehub-data-v3";

/// How long a peer has to prove itself once its channel is open. ICE and
/// DataChannel setup are waited for separately, up to [`RTC_ADMISSION_LIFETIME`].
pub(crate) const RTC_HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether this build can carry a direct RTC channel at all.
///
/// Both builds can. The answer is still asked for and answered honestly rather
/// than assumed, because a peer told `true` by a build that cannot will spend a
/// negotiation round finding out, and will report a failed upgrade where the
/// honest state is "this daemon has no RTC".
pub(crate) const SUPPORTED: bool = true;

#[cfg(not(target_family = "wasm"))]
#[path = "rtc_host.rs"]
mod carrier;

#[cfg(target_family = "wasm")]
#[path = "rtc_guest.rs"]
mod carrier;

pub(crate) use carrier::handle;

/// Channel-selected STUN, or explicit self-hosted local configuration. No public
/// third-party server is silently substituted when configuration is unavailable.
pub(crate) async fn ice_config(state: &crate::state::Shared) -> serde_json::Value {
    let file = state.paths.root.join("rtc.json");
    if let Ok(metadata) = std::fs::symlink_metadata(&file) {
        if metadata.is_file() && metadata.len() <= 16 * 1024 {
            if let Ok(bytes) = std::fs::read(&file) {
                if bytes.len() <= 16 * 1024 {
                    if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                        return value;
                    }
                }
            }
        }
    }
    if let Some(link) = state.link.get() {
        if let Ok(Ok(value)) =
            tokio::time::timeout(Duration::from_secs(3), link.rtc_config(None)).await
        {
            return value;
        }
    }
    serde_json::json!({"version":1,"iceServers":[],"turnAvailable":false})
}
pub(crate) fn stun_urls(value: &serde_json::Value) -> Vec<String> {
    value["iceServers"]
        .as_array()
        .into_iter()
        .flatten()
        .take(8)
        .flat_map(|server| server["urls"].as_array().into_iter().flatten())
        .filter_map(|url| url.as_str())
        .filter(|url| {
            url.starts_with("stun:")
                && url.len() <= 256
                && !url.contains(['@', '/', '\\', '\n', '\r'])
        })
        .take(8)
        .map(str::to_string)
        .collect()
}
pub(super) async fn config_handle(
    stream: &mut super::endpoint::ServerStream,
    services: &super::endpoint::PeerServices,
) -> anyhow::Result<()> {
    stream.read_body(0).await?;
    let value = ice_config(&services.state).await;
    let body = serde_json::to_vec(
        &serde_json::json!({"version":1,"iceServers":stun_urls(&value).into_iter().map(|url|serde_json::json!({"urls":[url]})).collect::<Vec<_>>()}),
    )?;
    stream
        .respond(&genehub_proto::ExchangeResponseHead {
            status: 200,
            metadata: serde_json::Value::Null,
            body_length: Some(body.len() as u64),
            error: None,
        })
        .await?;
    stream.write(&body).await?;
    stream.finish().await
}
