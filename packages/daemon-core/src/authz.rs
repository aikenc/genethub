//! Portable request and stream authorization policy.
//!
//! Native transport supplies only an authenticated caller identity. This
//! module owns grant migration, exhaustive request classification and the
//! event-filter decision, so a logic update can change policy without a new
//! platform binary.

use std::collections::BTreeSet;

use genehub_proto::{ErrorCode, ProtocolError, Request};
use genet_daemon_logic_api::{CallerContext, StreamAuthorization, StreamMethod};
use serde::{Deserialize, Serialize};

use crate::devices::Devices;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Handshake,
    Read,
    Session,
    Files,
    Git,
    Pty,
    PtyUnconfined,
    Devices,
    Settings,
    Speech,
    Update,
}

impl Capability {
    pub const ALL: [Self; 11] = [
        Self::Handshake,
        Self::Read,
        Self::Session,
        Self::Files,
        Self::Git,
        Self::Pty,
        Self::PtyUnconfined,
        Self::Devices,
        Self::Settings,
        Self::Speech,
        Self::Update,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Handshake => "handshake",
            Self::Read => "read",
            Self::Session => "session",
            Self::Files => "files",
            Self::Git => "git",
            Self::Pty => "pty",
            Self::PtyUnconfined => "pty:unconfined",
            Self::Devices => "devices",
            Self::Settings => "settings",
            Self::Speech => "speech",
            Self::Update => "update",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|capability| capability.as_str() == raw)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GrantSet(BTreeSet<Capability>);

impl GrantSet {
    pub fn full() -> Self {
        Self(Capability::ALL.into_iter().collect())
    }

    pub fn of(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        let mut grants: BTreeSet<_> = capabilities.into_iter().collect();
        grants.insert(Capability::Handshake);
        Self(grants)
    }

    pub fn allows(&self, capability: Capability) -> bool {
        capability == Capability::Handshake || self.0.contains(&capability)
    }

    pub fn names(&self) -> Vec<String> {
        self.0
            .iter()
            .map(|capability| capability.as_str().to_string())
            .collect()
    }

    #[cfg(test)]
    fn is_full(&self) -> bool {
        Capability::ALL
            .into_iter()
            .all(|capability| self.allows(capability))
    }

    pub fn add_speech_to_legacy_full(&mut self) {
        const LEGACY_FULL: [Capability; 9] = [
            Capability::Handshake,
            Capability::Read,
            Capability::Session,
            Capability::Files,
            Capability::Git,
            Capability::Pty,
            Capability::Devices,
            Capability::Settings,
            Capability::Update,
        ];
        if !self.0.contains(&Capability::Speech)
            && LEGACY_FULL
                .iter()
                .all(|capability| self.0.contains(capability))
        {
            self.0.insert(Capability::Speech);
        }
    }
}

impl Default for GrantSet {
    fn default() -> Self {
        Self::full()
    }
}

pub fn authorize_request(
    caller: &CallerContext,
    request: &Request,
    devices: &Devices,
) -> Result<(), ProtocolError> {
    authorize(caller, required(request), devices)
}

pub fn authorize_stream(
    caller: &CallerContext,
    stream: StreamMethod,
    devices: &Devices,
) -> StreamAuthorization {
    let required = stream_required(stream);
    let allowed = allows(caller, required, devices);
    let pty = allows(caller, Capability::Pty, devices);
    let session = allows(caller, Capability::Session, devices);
    StreamAuthorization {
        allowed,
        missing_grant: (!allowed).then(|| required.as_str().to_string()),
        confinement_required: pty && !allows(caller, Capability::PtyUnconfined, devices),
        receive_pty: pty,
        receive_background_processes: session,
    }
}

fn authorize(
    caller: &CallerContext,
    capability: Capability,
    devices: &Devices,
) -> Result<(), ProtocolError> {
    if allows(caller, capability, devices) {
        Ok(())
    } else {
        Err(ProtocolError {
            code: ErrorCode::Forbidden,
            message: format!(
                "this device was not granted `{}` on this machine",
                capability.as_str()
            ),
        })
    }
}

fn allows(caller: &CallerContext, capability: Capability, devices: &Devices) -> bool {
    match caller {
        CallerContext::LocalUser | CallerContext::Channel => true,
        CallerContext::Pairing => capability == Capability::Handshake,
        CallerContext::Device { device_id } => devices
            .grants(device_id)
            .is_some_and(|grants| grants.allows(capability)),
    }
}

fn stream_required(stream: StreamMethod) -> Capability {
    match stream {
        StreamMethod::Events | StreamMethod::RtcNegotiate => Capability::Handshake,
        StreamMethod::AssetPreview => Capability::Files,
        StreamMethod::ShellRun => Capability::Pty,
        StreamMethod::SpeechTranscribe => Capability::Speech,
    }
}

/// Exhaustive by design: a protocol addition cannot inherit authority by
/// accident.
pub fn required(request: &Request) -> Capability {
    match request {
        Request::ConnectionIdentity | Request::DeviceClaim { .. } => Capability::Handshake,

        Request::Subscribe { .. }
        | Request::Unsubscribe { .. }
        | Request::AgentList
        | Request::AgentRefresh
        | Request::SessionList { .. }
        | Request::SessionGet { .. }
        | Request::SessionInspect { .. }
        | Request::SessionNarrative { .. }
        | Request::SessionRounds { .. }
        | Request::SessionContext { .. }
        | Request::SessionImportList { .. }
        | Request::RoundTrunkList { .. }
        | Request::RoundTrunkGet { .. }
        | Request::BlobGet { .. }
        | Request::WorkspaceList
        | Request::DirectoryList { .. }
        | Request::FileTree { .. }
        | Request::LogTail { .. }
        | Request::DiagnosticsSnapshot
        | Request::HubStatus
        | Request::HubMachines
        | Request::SpeechCapabilities
        | Request::UpdateCheck
        | Request::UpdateDownloadState
        | Request::DaemonLogicStatus => Capability::Read,

        Request::FileWrite { .. }
        | Request::FileMkdir { .. }
        | Request::FileCopy { .. }
        | Request::FileMove { .. }
        | Request::FileDelete { .. }
        | Request::DirectoryMkdir { .. } => Capability::Files,

        Request::GitStatus { .. } | Request::GitDiff { .. } | Request::GitCommit { .. } => {
            Capability::Git
        }

        Request::SessionCreate { .. }
        | Request::SessionSend { .. }
        | Request::SessionArtifactBegin { .. }
        | Request::SessionArtifactChunk { .. }
        | Request::SessionArtifactFinish { .. }
        | Request::SessionArtifactAbort { .. }
        | Request::SessionFork { .. }
        | Request::SessionForkExport { .. }
        | Request::SessionForkImport { .. }
        | Request::SessionImport { .. }
        | Request::SessionInterrupt { .. }
        | Request::SessionClose { .. }
        | Request::SessionArchive { .. }
        | Request::SessionRename { .. }
        | Request::SessionDelete { .. }
        | Request::SessionSetModel { .. }
        | Request::SessionSetMode { .. }
        | Request::SessionSetEffort { .. }
        | Request::SessionRespondPermission { .. }
        | Request::ProcessList
        | Request::ProcessKill { .. }
        | Request::ProcessKillAll { .. } => Capability::Session,

        Request::SpeechContextPreview { .. } | Request::SpeechFeedbackRecord { .. } => {
            Capability::Speech
        }

        Request::PtyOpen { .. }
        | Request::PtyWrite { .. }
        | Request::PtyResize { .. }
        | Request::PtyClose { .. } => Capability::Pty,

        Request::WorkspaceOpen { .. }
        | Request::WorkspaceCreate { .. }
        | Request::WorkspaceRename { .. }
        | Request::WorkspaceRemove { .. }
        | Request::SettingsGet
        | Request::SettingsSetProvider { .. }
        | Request::SettingsForgetProvider { .. }
        | Request::SpeechSettingsSetQwen3 { .. }
        | Request::SpeechRuntimeProbe
        | Request::SpeechRuntimeConfigure { .. }
        | Request::HubPair { .. }
        | Request::HubTrial { .. }
        | Request::HubClaimLink
        | Request::HubConnect { .. }
        | Request::HubUnpair => Capability::Settings,

        Request::DeviceList
        | Request::DeviceInvite(_)
        | Request::DeviceRevoke { .. }
        | Request::DeviceRemoteAttach { .. }
        | Request::DeviceRemoteDetach => Capability::Devices,

        Request::UpdateDownload
        | Request::UpdateDismiss
        | Request::DaemonLogicInstall { .. }
        | Request::DaemonLogicRollback => Capability::Update,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grant_names_round_trip() {
        for capability in Capability::ALL {
            assert_eq!(Capability::parse(capability.as_str()), Some(capability));
        }
    }

    #[test]
    fn handshake_is_never_removed() {
        let grants = GrantSet::of([Capability::Read]);
        assert!(grants.allows(Capability::Handshake));
        assert!(!grants.allows(Capability::Pty));
        assert!(!grants.is_full());
    }

    #[test]
    fn pre_grant_devices_keep_the_legacy_full_default() {
        let restored: GrantSet = serde_json::from_str("null").unwrap_or_default();
        assert!(restored.is_full());
        assert!(GrantSet::default().is_full());
    }

    #[test]
    fn local_channel_and_pairing_authority_remain_distinct() {
        let devices = Devices::default();
        for capability in Capability::ALL {
            assert!(allows(&CallerContext::LocalUser, capability, &devices));
            assert!(allows(&CallerContext::Channel, capability, &devices));
            assert_eq!(
                allows(&CallerContext::Pairing, capability, &devices),
                capability == Capability::Handshake
            );
        }
    }

    #[test]
    fn a_narrowed_device_loses_exactly_what_it_was_not_given() {
        let devices: Devices = serde_json::from_value(serde_json::json!({
            "loaded": true,
            "devices": [{
                "id": "d_1",
                "name": "phone",
                "secret": "00",
                "pairedAt": "2026-08-15T00:00:00Z",
                "lastSeenAt": null,
                "grants": ["handshake", "read", "session"],
                "grantsVersion": 1
            }],
            "invites": [],
            "seenNonces": [],
            "connected": {}
        }))
        .unwrap();
        let caller = CallerContext::Device {
            device_id: "d_1".into(),
        };
        assert!(allows(&caller, Capability::Session, &devices));
        assert!(!allows(&caller, Capability::Pty, &devices));
        assert!(!allows(&caller, Capability::Devices, &devices));
    }

    #[test]
    fn request_classes_keep_powerful_operations_separate() {
        assert_eq!(
            required(&Request::PtyOpen {
                workspace_id: "w".into(),
                cols: Some(80),
                rows: Some(24),
            }),
            Capability::Pty
        );
        assert_eq!(
            required(&Request::FileWrite {
                workspace_id: "w".into(),
                path: "a".into(),
                content: String::new(),
            }),
            Capability::Files
        );
        assert_eq!(required(&Request::WorkspaceList), Capability::Read);
        assert_eq!(
            required(&Request::DeviceRevoke {
                device_id: "d".into(),
            }),
            Capability::Devices
        );
    }

    #[test]
    fn stream_bytes_cost_the_same_authority_as_their_rpc_equivalents() {
        assert_eq!(
            stream_required(StreamMethod::AssetPreview),
            Capability::Files
        );
        assert_eq!(stream_required(StreamMethod::Events), Capability::Handshake);
        assert_eq!(stream_required(StreamMethod::ShellRun), Capability::Pty);
        assert_eq!(
            stream_required(StreamMethod::SpeechTranscribe),
            Capability::Speech
        );
    }

    #[test]
    fn artifact_bytes_are_session_scoped_not_general_files() {
        assert_eq!(
            required(&Request::SessionArtifactBegin {
                session_id: "s".into(),
                files: vec![genehub_proto::SessionArtifactFile {
                    name: "events.jsonl".into(),
                    mime: "application/x-ndjson".into(),
                    bytes: 0,
                }],
                metadata: serde_json::json!({}),
            }),
            Capability::Session
        );
        assert_eq!(
            required(&Request::SessionArtifactChunk {
                session_id: "s".into(),
                upload_id: "u".into(),
                file_index: 0,
                offset: 0,
                data_base64: String::new(),
            }),
            Capability::Session
        );
    }

    #[test]
    fn speech_keeps_explicit_request_and_stream_gates() {
        assert_eq!(
            stream_required(StreamMethod::SpeechTranscribe),
            Capability::Speech
        );
        assert_eq!(
            required(&Request::SpeechContextPreview {
                workspace_id: "w".into(),
                session_id: None,
                draft: None,
            }),
            Capability::Speech
        );
        assert_eq!(required(&Request::SpeechCapabilities), Capability::Read);
        assert_eq!(required(&Request::SpeechRuntimeProbe), Capability::Settings);
    }

    #[test]
    fn only_the_exact_legacy_full_shape_gains_speech() {
        let mut legacy_full = GrantSet::of([
            Capability::Read,
            Capability::Session,
            Capability::Files,
            Capability::Git,
            Capability::Pty,
            Capability::Devices,
            Capability::Settings,
            Capability::Update,
        ]);
        legacy_full.add_speech_to_legacy_full();
        assert!(legacy_full.allows(Capability::Speech));

        let mut narrowed = GrantSet::of([Capability::Read, Capability::Session]);
        narrowed.add_speech_to_legacy_full();
        assert!(!narrowed.allows(Capability::Speech));
    }
}
