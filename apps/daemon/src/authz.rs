//! Native projection of authenticated transport identity.
//!
//! This module deliberately contains no grants and no request classification.
//! The signed guest owns that policy; native code only reports which already
//! authenticated peer opened the stream and enforces the guest's answer.

use genet_daemon_logic_api::{CallerContext, StreamMethod};

use crate::dataplane::endpoint::PeerAccess;

pub fn principal(access: &PeerAccess) -> CallerContext {
    if access.bootstrap_invite.is_some() {
        return CallerContext::Pairing;
    }
    match access.device_id.as_deref() {
        Some(device_id) => CallerContext::Device {
            device_id: device_id.to_string(),
        },
        None if access.transport == genehub_proto::TransportKind::Loopback => {
            CallerContext::LocalUser
        }
        None => CallerContext::Channel,
    }
}

pub fn stream_method(method: &str) -> Option<StreamMethod> {
    match method {
        "events" => Some(StreamMethod::Events),
        genehub_proto::LOGIC_IDENTITY_METHOD => Some(StreamMethod::LogicIdentity),
        genehub_proto::PATCH_CONTROL_METHOD => Some(StreamMethod::PatchControl),
        "asset.preview" => Some(StreamMethod::AssetPreview),
        "shell.run" => Some(StreamMethod::ShellRun),
        "rtc.negotiate" => Some(StreamMethod::RtcNegotiate),
        genehub_proto::SPEECH_TRANSCRIBE_METHOD => Some(StreamMethod::SpeechTranscribe),
        _ => None,
    }
}

/// Converts the guest's bounded grant vocabulary into the equally bounded
/// privacy-safe diagnostic vocabulary. Arbitrary guest/client text must never
/// enter the support ring.
pub fn diagnostic_grant_code(grant: &str) -> &'static str {
    match grant {
        "sessions:read" => "sessions_read",
        "sessions:write" => "sessions_write",
        "files" => "files",
        "pty" => "pty",
        "pty:unconfined" => "pty_unconfined",
        "settings" => "settings",
        "devices" => "devices",
        "speech" => "speech",
        _ => "unknown",
    }
}
