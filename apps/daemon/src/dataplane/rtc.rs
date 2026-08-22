//! Endpoint-neutral E2EE RTC. Native uses webrtc-rs; the WASI guest refuses.

/// Whether this build can carry a direct RTC channel at all.
///
/// `webrtc-rs` is a native stack — ICE wants raw UDP and its own timers — so
/// the component cannot host one, and the baseline WSS Fabric carries
/// everything instead. That is a slower path, not a missing one: `DataEndpoint`
/// treats the baseline as the transport, and RTC only ever as an upgrade.
///
/// The answer belongs in `connection.identity` because a peer that is told
/// `true` will spend a negotiation round finding out otherwise, and will report
/// a failed upgrade where the honest state is "this daemon has no RTC".
pub(crate) const SUPPORTED: bool = cfg!(not(target_family = "wasm"));

#[cfg(not(target_family = "wasm"))]
#[path = "rtc_host.rs"]
mod host;

#[cfg(not(target_family = "wasm"))]
pub(crate) use host::handle;

#[cfg(target_family = "wasm")]
mod guest {
    use anyhow::Result;
    use genehub_proto::ErrorCode;

    use super::super::endpoint::{self, PeerServices, ServerStream};

    pub(crate) async fn handle(
        stream: &mut ServerStream,
        _services: &PeerServices,
    ) -> Result<()> {
        endpoint::send_error(
            stream,
            503,
            ErrorCode::Unsupported,
            "a direct RTC channel could not be established",
        )
        .await
    }
}

#[cfg(target_family = "wasm")]
pub(crate) use guest::handle;
