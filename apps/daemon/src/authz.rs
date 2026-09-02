//! Who may ask this machine for what.
//!
//! Everything that reaches a machine from outside — the workbench, a phone, the
//! CLI on another laptop — arrives as the same peer on the same data plane, so
//! "all authorized devices can do everything" was true by construction rather
//! than by decision. This module makes it a decision.
//!
//! Two properties matter more than the policy itself. The classification is
//! **exhaustive**: `required` matches every `Request` variant by name, so
//! adding one to the protocol without saying what it costs fails to compile
//! rather than defaulting to allowed. And it is in **one place**: a rule spread
//! across call sites is a rule with holes in it, and the holes are found by
//! whoever is looking hardest.
//!
//! Requests are not the whole attack surface. A peer also opens non-RPC
//! streams, and `asset.preview` returns file bytes. `StreamMethod` covers those
//! by the same exhaustive rule, because a capability system that only guards
//! the JSON requests guards the half that is easiest to enumerate.
//!
//! The default is deliberately permissive. A device paired before this existed
//! holds every grant, because a daemon update that silently locks out the phone
//! someone relies on is a worse failure than a broad grant they chose.
//! Narrowing is opt-in, at the moment a device is invited.

use std::collections::BTreeSet;

use genehub_proto::Request;
use serde::{Deserialize, Serialize};

use crate::dataplane::endpoint::PeerAccess;
use crate::state::Shared;

/// One unit of authority. Coarse on purpose: a list long enough to be precise
/// is a list nobody reads before clicking accept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    /// Establishing and describing the connection itself. Always allowed,
    /// because refusing it would leave a caller no way to prove it should be
    /// allowed anything else.
    Handshake,
    /// Looking: workspaces, sessions, agents, logs, the machine's own state,
    /// and the names of files. Not their contents.
    Read,
    /// Making the machine work: opening sessions, sending prompts, answering
    /// permission requests.
    Session,
    /// File contents, in either direction, outside of a session.
    Files,
    /// Repository operations, including commits.
    Git,
    /// The terminal. Separate from `Files` because a shell is not a file
    /// editor: it is every capability the account has, at once.
    Pty,
    /// A terminal the operating system is *not* holding to the workspace.
    ///
    /// Held apart from `Pty` because it is the difference between "may open a
    /// terminal here" and "may open a terminal that can read the whole
    /// account". Every device paired before this existed holds it, so nothing
    /// they could do yesterday stopped working; a narrowed invitation can hand
    /// out `pty` alone and get a confined one (`genet-remote-execution.md`
    /// §7.6).
    PtyUnconfined,
    /// Deciding who else may reach this machine.
    Devices,
    /// Machine configuration and stored provider credentials.
    Settings,
    /// Capturing audio, compiling workspace context and spending speech
    /// provider quota. Separate from Agent sessions and from file access.
    Speech,
    /// Replacing the software this machine runs.
    Update,
}

impl Capability {
    pub const ALL: [Capability; 11] = [
        Capability::Handshake,
        Capability::Read,
        Capability::Session,
        Capability::Files,
        Capability::Git,
        Capability::Pty,
        Capability::PtyUnconfined,
        Capability::Devices,
        Capability::Settings,
        Capability::Speech,
        Capability::Update,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Capability::Handshake => "handshake",
            Capability::Read => "read",
            Capability::Session => "session",
            Capability::Files => "files",
            Capability::Git => "git",
            Capability::Pty => "pty",
            Capability::PtyUnconfined => "pty:unconfined",
            Capability::Devices => "devices",
            Capability::Settings => "settings",
            Capability::Speech => "speech",
            Capability::Update => "update",
        }
    }

    pub fn parse(raw: &str) -> Option<Capability> {
        Capability::ALL
            .into_iter()
            .find(|capability| capability.as_str() == raw)
    }
}

/// What a device was given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct GrantSet(BTreeSet<Capability>);

impl GrantSet {
    pub fn full() -> Self {
        GrantSet(Capability::ALL.into_iter().collect())
    }

    pub fn of(capabilities: impl IntoIterator<Item = Capability>) -> Self {
        let mut grants: BTreeSet<Capability> = capabilities.into_iter().collect();
        // Without it a device could not complete a handshake, so a grant set
        // that omits it is a typo rather than a policy.
        grants.insert(Capability::Handshake);
        GrantSet(grants)
    }

    pub fn allows(&self, capability: Capability) -> bool {
        capability == Capability::Handshake || self.0.contains(&capability)
    }

    pub fn is_full(&self) -> bool {
        Capability::ALL
            .into_iter()
            .all(|capability| self.allows(capability))
    }

    pub fn names(&self) -> Vec<String> {
        self.0
            .iter()
            .map(|capability| capability.as_str().to_string())
            .collect()
    }

    /// Files written before the speech grant existed represented "full" as
    /// every then-known capability. Migrate only that exact legacy shape;
    /// deliberately narrowed devices keep their narrower authority.
    pub(crate) fn add_speech_to_legacy_full(&mut self) {
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
        GrantSet::full()
    }
}

/// Who is on the other end of a peer link.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// Reached the loopback listener with the one-use owner-only proof. That
    /// caller can already read files as this account and start processes as it,
    /// so withholding a capability here would protect nothing.
    LocalUser,
    /// A loopback CLI invocation carrying a daemon-verified proof minted for
    /// one durable ordinary Session. It may inspect project state and drive
    /// only Workflow children whose parent is that exact Session.
    SessionController { session_id: String },
    /// A paired device, holding exactly what it was granted.
    Device { id: String, grants: GrantSet },
    /// An end-to-end authenticated hosted channel that never identified as a
    /// device. It keeps the authority it has always had; narrowing it belongs
    /// with the hosted enrolment that issues it, not here.
    Channel,
    /// A peer that authenticated with a pairing invitation. It may redeem that
    /// invitation and nothing else, which the data plane enforces before this
    /// layer is consulted.
    Pairing,
}

impl Principal {
    /// Resolves the caller behind an already authenticated peer.
    ///
    /// Grants are read per request rather than cached at handshake, so a device
    /// revoked mid-connection stops being able to act at once instead of when
    /// it next reconnects.
    pub fn of(state: &Shared, access: &PeerAccess) -> Principal {
        if access.bootstrap_invite.is_some() {
            return Principal::Pairing;
        }
        match access.device_id.as_deref() {
            Some(device_id) => match state.devices.grants(device_id) {
                Some(grants) => Principal::Device {
                    id: device_id.to_string(),
                    grants,
                },
                // Authenticated as a device that no longer exists: revoked
                // while connected. Nothing beyond the handshake.
                None => Principal::Device {
                    id: device_id.to_string(),
                    grants: GrantSet::of([]),
                },
            },
            None => match access.transport {
                genehub_proto::TransportKind::Loopback => Principal::LocalUser,
                _ => Principal::Channel,
            },
        }
    }

    pub fn allows(&self, capability: Capability) -> bool {
        match self {
            Principal::LocalUser | Principal::Channel => true,
            Principal::SessionController { .. } => matches!(
                capability,
                Capability::Handshake | Capability::Read | Capability::Session
            ),
            Principal::Device { grants, .. } => grants.allows(capability),
            Principal::Pairing => capability == Capability::Handshake,
        }
    }

    pub fn device_id(&self) -> Option<&str> {
        match self {
            Principal::Device { id, .. } => Some(id),
            _ => None,
        }
    }

    pub fn session_controller_id(&self) -> Option<&str> {
        match self {
            Principal::SessionController { session_id } => Some(session_id),
            _ => None,
        }
    }
}

/// The non-RPC streams a peer may open.
///
/// Kept as an enum rather than matching on the method string at the gate, so
/// that adding a stream to `handle_stream` without classifying it does not
/// silently inherit whatever the last arm happened to allow.
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
    /// Moves this same authenticated peer onto a direct carrier.
    RtcNegotiate,
    /// Provider-neutral speech-to-text duplex flow.
    SpeechTranscribe,
}

impl StreamMethod {
    pub fn parse(method: &str) -> Option<StreamMethod> {
        match method {
            "events" => Some(StreamMethod::Events),
            genehub_proto::PROTOCOL_IDENTITY_METHOD => Some(StreamMethod::ProtocolIdentity),
            "asset.preview" => Some(StreamMethod::AssetPreview),
            "shell.run" => Some(StreamMethod::ShellRun),
            "rtc.negotiate" => Some(StreamMethod::RtcNegotiate),
            genehub_proto::SPEECH_TRANSCRIBE_METHOD => Some(StreamMethod::SpeechTranscribe),
            _ => None,
        }
    }

    pub fn required(self) -> Capability {
        match self {
            // The stream itself carries only what its per-frame gates already
            // allowed; opening it proves nothing and grants nothing.
            StreamMethod::Events | StreamMethod::ProtocolIdentity => Capability::Handshake,
            // Returns file bytes. That it arrives as a stream rather than a
            // request does not make it a cheaper thing to hand out.
            StreamMethod::AssetPreview => Capability::Files,
            // The same authority as a terminal, deliberately not a grant of
            // its own. Running one command and opening a shell to run it are
            // the same power, and a separate name for one of them would invite
            // an invitation that looks narrower than it is.
            StreamMethod::ShellRun => Capability::Pty,
            // A transport upgrade for an already authenticated peer, which
            // inherits that peer's device identity and scope.
            StreamMethod::RtcNegotiate => Capability::Handshake,
            StreamMethod::SpeechTranscribe => Capability::Speech,
        }
    }
}

/// What a request costs.
///
/// Exhaustive by name and with no wildcard arm: that is the whole mechanism.
/// A new `Request` variant will not compile until someone decides what
/// authority it needs, which is the one moment when the answer is obvious.
pub fn required(request: &Request) -> Capability {
    match request {
        Request::ConnectionIdentity | Request::DeviceClaim { .. } => Capability::Handshake,

        // Listing tells you what exists; contents tell you what is in it. Those
        // are different things to hand out, so the tree and the bytes are
        // filed apart.
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
        | Request::WorkflowInspect { .. }
        | Request::WorkflowGet { .. }
        | Request::SessionImportList { .. }
        | Request::RoundTrunkList { .. }
        | Request::RoundTrunkGet { .. }
        | Request::RoundTrunkBatchGet { .. }
        | Request::BlobGet { .. }
        | Request::BlobBatchGet { .. }
        | Request::WorkspaceList
        | Request::DirectoryList { .. }
        | Request::FileTree { .. }
        | Request::LogTail { .. }
        | Request::DiagnosticsSnapshot
        | Request::HubStatus
        | Request::HubMachines
        | Request::SpeechCapabilities
        | Request::UpdateCheck
        | Request::UpdateAppCheck
        | Request::UpdateDownloadState => Capability::Read,

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
        | Request::WorkflowDispatch { .. }
        | Request::WorkflowComplete { .. }
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
        | Request::SessionSetRuntimeAxis { .. }
        | Request::SessionRespondPermission { .. } => Capability::Session,

        Request::SpeechContextPreview { .. } | Request::SpeechFeedbackRecord { .. } => {
            Capability::Speech
        }

        Request::PtyOpen { .. }
        | Request::PtyWrite { .. }
        | Request::PtyResize { .. }
        | Request::PtyClose { .. } => Capability::Pty,

        // Seeing and ending what a session's agent left running is part of
        // driving that session, not a separate power: whoever may send a turn
        // may already start these processes, so withholding the ability to
        // stop them would only mean they accumulate.
        Request::ProcessList | Request::ProcessKill { .. } | Request::ProcessKillAll { .. } => {
            Capability::Session
        }

        // Opening or removing a workspace changes what this machine exposes at
        // all, so it sits with the other configuration changes rather than with
        // reading one.
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

        Request::UpdateDownload | Request::UpdateDismiss => Capability::Update,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grant_set_always_keeps_the_handshake_it_needs_to_be_usable() {
        let narrow = GrantSet::of([Capability::Read]);
        assert!(narrow.allows(Capability::Handshake));
        assert!(narrow.allows(Capability::Read));
        assert!(!narrow.allows(Capability::Pty));
        assert!(!narrow.is_full());
    }

    #[test]
    fn a_device_paired_before_grants_existed_keeps_everything() {
        // Locking out the phone someone relies on, on a routine update, is a
        // worse outcome than a broad grant they chose.
        let restored: GrantSet = serde_json::from_str("null").unwrap_or_default();
        assert!(restored.is_full());
        assert!(GrantSet::default().is_full());
    }

    #[test]
    fn the_local_user_is_not_gated_because_gating_them_would_protect_nothing() {
        for capability in Capability::ALL {
            assert!(Principal::LocalUser.allows(capability));
        }
    }

    #[test]
    fn a_pairing_peer_may_only_finish_pairing() {
        assert!(Principal::Pairing.allows(Capability::Handshake));
        for capability in Capability::ALL
            .into_iter()
            .filter(|capability| *capability != Capability::Handshake)
        {
            assert!(!Principal::Pairing.allows(capability));
        }
    }

    #[test]
    fn a_narrowed_device_loses_exactly_what_it_was_not_given() {
        let principal = Principal::Device {
            id: "d_1".into(),
            grants: GrantSet::of([Capability::Read, Capability::Session]),
        };
        assert!(principal.allows(Capability::Session));
        assert!(!principal.allows(Capability::Pty));
        assert!(!principal.allows(Capability::Devices));
        assert_eq!(principal.device_id(), Some("d_1"));
    }

    #[test]
    fn capability_names_round_trip_because_they_are_stored_and_typed_by_people() {
        for capability in Capability::ALL {
            assert_eq!(Capability::parse(capability.as_str()), Some(capability));
        }
        assert_eq!(Capability::parse("root"), None);
    }

    #[test]
    fn a_terminal_is_not_filed_under_reading_or_editing_files() {
        // A shell is every capability the account has at once, so it must be
        // possible to withhold it from a device that may still edit files.
        assert_eq!(
            required(&Request::PtyOpen {
                workspace_id: "w".into(),
                cols: Some(80),
                rows: Some(24)
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
                device_id: "d".into()
            }),
            Capability::Devices
        );
    }

    #[test]
    fn file_bytes_cost_the_same_whether_they_arrive_as_a_request_or_a_stream() {
        // asset.preview is the only way to read file contents on this plane.
        // Leaving it at handshake would make the Files grant decorative.
        assert_eq!(
            StreamMethod::parse("asset.preview").map(StreamMethod::required),
            Some(Capability::Files)
        );
        assert_eq!(
            StreamMethod::parse("events").map(StreamMethod::required),
            Some(Capability::Handshake)
        );
        assert_eq!(
            StreamMethod::parse(genehub_proto::PROTOCOL_IDENTITY_METHOD)
                .map(StreamMethod::required),
            Some(Capability::Handshake)
        );
        assert_eq!(StreamMethod::parse("rpc"), None);
    }

    #[test]
    fn artifact_bytes_are_scoped_to_their_session_not_general_files() {
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
    fn speech_has_an_explicit_request_and_stream_gate() {
        assert_eq!(
            StreamMethod::parse(genehub_proto::SPEECH_TRANSCRIBE_METHOD)
                .map(StreamMethod::required),
            Some(Capability::Speech)
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
        assert_eq!(
            required(&Request::SpeechFeedbackRecord {
                workspace_id: "w".into(),
                request_id: "r".into(),
                context_snapshot_id: "sc".into(),
                candidates: vec![],
                selected_candidate_id: "c".into(),
                rejected_candidate_id: None,
                scope: None,
                score_kind: genehub_proto::SpeechScoreKind::MockRelative,
            }),
            Capability::Speech
        );
    }

    #[test]
    fn only_the_exact_legacy_full_shape_gains_speech_during_migration() {
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
