//! Authenticated identity and the two non-executing entry points.
//!
//! Complete Agent connections use the daemon OS account's authority. Identity
//! remains attributable; pairing and preview sharing never inherit execution.
use crate::{dataplane::endpoint::PeerAccess, state::Shared};
use genehub_proto::Request;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    LocalUser,
    SessionController { session_id: String },
    Device { id: String },
    Channel,
    PreviewShare { id: String },
    Pairing,
    RevokedDevice { id: String },
    Unauthenticated,
}

impl Principal {
    pub fn of(state: &Shared, access: &PeerAccess) -> Self {
        if let Some(id) = access.principal.strip_prefix("preview:") {
            return Self::PreviewShare { id: id.into() };
        }
        if access.bootstrap_invite.is_some() {
            return Self::Pairing;
        }
        if let Some(id) = &access.device_id {
            return if state.devices.authorized(id) {
                Self::Device { id: id.clone() }
            } else {
                Self::RevokedDevice { id: id.clone() }
            };
        }
        match access.transport {
            genehub_proto::TransportKind::Loopback if access.principal == "loopback" => {
                Self::LocalUser
            }
            _ if access.principal.starts_with("hosted:") => Self::Channel,
            _ => Self::Unauthenticated,
        }
    }

    pub fn is_full(&self) -> bool {
        match self {
            Self::LocalUser
            | Self::SessionController { .. }
            | Self::Device { .. }
            | Self::Channel => true,
            Self::PreviewShare { .. }
            | Self::Pairing
            | Self::RevokedDevice { .. }
            | Self::Unauthenticated => false,
        }
    }

    pub fn permits(&self, request: &Request) -> bool {
        match self {
            Self::PreviewShare { .. } => matches!(
                request,
                Request::ConnectionIdentity | Request::PreviewFeedback(_)
            ),
            Self::Pairing => matches!(request, Request::DeviceClaim { .. }),
            Self::RevokedDevice { .. } | Self::Unauthenticated => false,
            _ => self.is_full(),
        }
    }

    pub fn permits_stream(&self, method: StreamMethod) -> bool {
        match self {
            Self::PreviewShare { .. } => matches!(
                method,
                StreamMethod::Events | StreamMethod::ProtocolIdentity | StreamMethod::AssetPreview
            ),
            Self::Pairing => method == StreamMethod::ProtocolIdentity,
            Self::RevokedDevice { .. } | Self::Unauthenticated => false,
            _ => self.is_full(),
        }
    }

    pub fn authority(&self) -> genehub_proto::CallerAuthority {
        genehub_proto::CallerAuthority {
            principal_type: match self {
                Self::LocalUser => "localUser", Self::SessionController { .. } => "sessionController",
                Self::Device { .. } => "pairedDevice", Self::Channel => "channel",
                Self::PreviewShare { .. } => "previewShare", Self::Pairing => "pairing",
                Self::RevokedDevice { .. } => "revokedDevice",
                Self::Unauthenticated => "unauthenticated",
            }.into(),
            session_id: self.session_controller_id().map(str::to_owned),
            provider_operations: self.is_full(),
            provider_request_command: "provider configure <id> --session <id> --action <stable-id> --base-url <url> --dialect <openai|anthropic> --label <name> [--model <id>]".into(),
        }
    }

    pub fn device_id(&self) -> Option<&str> {
        match self {
            Self::Device { id } | Self::RevokedDevice { id } => Some(id),
            _ => None,
        }
    }
    pub fn session_controller_id(&self) -> Option<&str> {
        match self {
            Self::SessionController { session_id } => Some(session_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamMethod {
    /// The peer's single fan-in of session, terminal and notice frames.
    Events,
    /// Lean carrier method that returns the advertised WebProtocol.
    ProtocolIdentity,
    /// Streams the bytes of a workspace file.
    AssetPreview,
    /// Runs a command and streams what it writes.
    ShellRun,
    /// Streams one file's bytes from an offset, for a peer downloading it.
    FileRead,
    /// Moves this same authenticated peer onto a direct carrier.
    RtcNegotiate,
    RtcConfig,
    /// Provider-neutral speech-to-text duplex flow.
    SpeechTranscribe,
    ServicePreview,
}

impl StreamMethod {
    pub fn parse(method: &str) -> Option<StreamMethod> {
        match method {
            "events" => Some(StreamMethod::Events),
            genehub_proto::PROTOCOL_IDENTITY_METHOD => Some(StreamMethod::ProtocolIdentity),
            "asset.preview" => Some(StreamMethod::AssetPreview),
            "service.preview" => Some(StreamMethod::ServicePreview),
            "shell.run" => Some(StreamMethod::ShellRun),
            "file.read" => Some(StreamMethod::FileRead),
            "rtc.negotiate" => Some(StreamMethod::RtcNegotiate),
            "rtc.config" => Some(StreamMethod::RtcConfig),
            genehub_proto::SPEECH_TRANSCRIBE_METHOD => Some(StreamMethod::SpeechTranscribe),
            _ => None,
        }
    }
}
