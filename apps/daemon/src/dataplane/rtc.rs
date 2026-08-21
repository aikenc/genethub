//! Endpoint-neutral E2EE RTC. Native uses webrtc-rs; the WASI guest refuses.

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
