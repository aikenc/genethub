//! Stable application messages crossing the daemon platform/Wasm boundary.
//!
//! The ABI itself moves one bounded byte buffer in and one bounded byte buffer
//! out per event. These types describe those buffers; individual strings never
//! become host calls, which keeps the native platform independent of business
//! schemas and avoids chatty FFI.

use std::collections::BTreeMap;

use genehub_proto::{
    DeviceAuth, DeviceCredential, HubClaim, HubMachine, HubStatus, HubTicket, InviteAuth,
    IsolationInfo, ProtocolError, RemoteAccess, Reply, Request, SequencedEvent, ServerFrame,
    SpeechCandidate, SpeechCapabilities, SpeechRuntimeDescriptor, SpeechRuntimeStatus,
    SpeechScoreKind, SpeechSegment, SpeechStart, SupportDiagnostics, TransportKind,
};
use serde::{Deserialize, Serialize};

pub fn encode_message<T: Serialize>(label: &str, value: &T) -> Result<Vec<u8>, String> {
    rmp_serde::to_vec_named(value).map_err(|error| format!("encoding {label}: {error}"))
}

pub fn decode_message<T: for<'de> Deserialize<'de>>(
    label: &str,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<T, String> {
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err(format!(
            "{label} is {} bytes, expected 1 through {max_bytes}",
            bytes.len()
        ));
    }
    rmp_serde::from_slice(bytes).map_err(|error| format!("decoding {label}: {error}"))
}

/// Core-Wasm export contract implemented by `genet-daemon-logic`.
pub const ABI_VERSION: u32 = 19;
pub const MAX_CAPABILITY_BATCH: usize = 64;
pub const MAX_CAPABILITY_CHUNK_BYTES: usize = 3 * 1024 * 1024;

/// Portable product settings for the resident speech driver. The signed guest
/// owns and persists this value; native code receives a copy only when it must
/// start or probe an OS process.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpeechConfig {
    pub runtime: Option<SpeechRuntimeConfig>,
    pub stub_enabled: bool,
    pub context_enabled: bool,
    pub pinned_terms: Vec<String>,
    pub language_hints: Vec<String>,
    /// Legacy machine-wide consent. It is read for migration only and never
    /// projected back as active consent.
    pub collect_corrections: bool,
    pub correction_workspaces: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechRuntimeConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
}

/// Authoritative result retained by the signed application for a later
/// correction choice. The native audio driver supplies this once after it has
/// validated a runtime completion; client-provided transcript fields are never
/// accepted as training evidence.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SpeechCompletionEvidence {
    pub recorded_at_millis: i64,
    pub workspace_id: String,
    pub request_id: String,
    pub runtime: SpeechRuntimeDescriptor,
    pub context_snapshot_id: String,
    pub candidates: Vec<SpeechCandidate>,
    pub segments: Vec<SpeechSegment>,
    pub score_kind: SpeechScoreKind,
    pub scores_calibrated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicBoot {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub machine_id: String,
    pub fingerprint: String,
    pub machine_name: String,
    pub rtc_supported: bool,
    /// Platform facts advertised by the portable router. The native shell
    /// discovers them; the guest decides how they appear in the product
    /// protocol.
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub isolation: Option<IsolationInfo>,
    /// Capability-relative directory visible inside the WASI sandbox.
    pub log_directory: String,
    /// Native path shown to a local user; never used for guest file access.
    pub log_display_directory: String,
    /// Platform-discovered first-run workspace. The guest decides whether to
    /// create/register it; the native side only supplies the OS-specific path.
    #[serde(default)]
    pub default_workspace: Option<String>,
    #[serde(default)]
    pub home_directory: Option<String>,
    /// Platform-resolved path of the bundled Agent executable. The guest owns
    /// launch policy; native code only resolves the OS-specific sibling name.
    #[serde(default)]
    pub builtin_agent_binary: Option<String>,
    /// Channel-stamped environment variable understood by that executable.
    /// The value is platform/build metadata; the guest still decides the
    /// per-session directory assigned to it.
    #[serde(default)]
    pub builtin_agent_home_env: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicRequest {
    /// Native-call correlation only. It is opaque to product clients and lets
    /// one guest instance suspend multiple requests on batched capabilities.
    pub call_id: u64,
    pub transport: TransportKind,
    /// Authenticated identity only. Grants and request classification remain
    /// in the guest, so native transport cannot silently grow a second policy
    /// router.
    pub caller: CallerContext,
    /// Authenticated route facts supplied by the carrier. Business field
    /// interpretation and scope comparison happen inside the guest.
    #[serde(default)]
    pub route: RequestRoute,
    pub request: Request,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestRoute {
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub bootstrap_invite: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CallerContext {
    LocalUser,
    Device {
        device_id: String,
    },
    #[default]
    Channel,
    Pairing,
}

/// Every invocation of `genehub_handle` carries exactly one bounded event.
/// Capability completions and resource events use the same byte-batch ABI as
/// client requests; no String or business field becomes a host import.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum LogicInput {
    Request(LogicRequest),
    Platform(PlatformCall),
    CapabilityResults(CapabilityResults),
    CapabilityEvent(CapabilityEvent),
}

/// Native/Wasm carrier request. `body` is the exact external business JSON;
/// Platform validates only its byte bound and never deserializes a Request.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierRequest {
    pub call_id: u64,
    pub transport: TransportKind,
    pub caller: CallerContext,
    #[serde(default)]
    pub route: RequestRoute,
    pub body: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CarrierInput {
    Request(CarrierRequest),
    Platform(PlatformCall),
    CapabilityResults(CapabilityResults),
    CapabilityEvent(CapabilityEvent),
}

/// Native transport asks the signed application to make a security decision
/// through the same bounded byte ABI as ordinary RPC. The platform still owns
/// sockets and AEAD records; authorization state and replay policy stay
/// independently replaceable inside the guest.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCall {
    pub call_id: u64,
    pub request: PlatformRequest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum PlatformRequest {
    AuthenticateDevice {
        auth: DeviceAuth,
        server_nonce: String,
    },
    AuthenticateInvite {
        auth: InviteAuth,
        server_nonce: String,
    },
    ClaimAuthenticatedInvite {
        invite_id: String,
        device_name: String,
    },
    DeviceConnection {
        device_id: String,
        connected: bool,
    },
    /// Authorizes a non-RPC data-plane stream and returns the event classes
    /// this connection may observe. The platform only enforces the answer.
    AuthorizeStream {
        caller: CallerContext,
        stream: StreamMethod,
    },
    /// Path-free projection consumed by the native Hub carrier.
    WorkspaceCatalog,
    /// Resolves a client-visible workspace path to one already-registered
    /// opaque root capability. Native code never receives the workspace
    /// registry or decides which root a request belongs to.
    ResolveWorkspaceFile {
        workspace_id: String,
        path: String,
    },
    /// Resolves the complete workspace confinement set plus a requested cwd.
    /// Native command streaming receives only opaque locators, never the
    /// guest's workspace catalogue or path-selection policy.
    ResolveWorkspaceExecution {
        workspace_id: String,
        #[serde(default)]
        cwd: Option<String>,
    },
    /// Validates a speech stream against guest-owned workspace/session state
    /// and returns the current portable runtime selection. The native stream
    /// driver never reads product configuration directly.
    PrepareSpeech {
        #[serde(default)]
        route_workspace_id: Option<String>,
        start: SpeechStart,
    },
    /// Stable cold-update gate. The guest reports transient work and, only
    /// after explicit confirmation, terminates it before Platform quiesces OS
    /// resources and replaces the instance.
    PrepareUpdate {
        terminate_activities: bool,
    },
    /// Transfers one already-validated completion from the resident audio
    /// driver into guest-owned feedback policy. This is a single bounded
    /// message, not a field-by-field string ABI.
    RememberSpeechCompletion {
        evidence: SpeechCompletionEvidence,
    },
    /// Gives the portable application a final bounded opportunity to stop
    /// session-owned descendants before native resource tables disappear.
    /// Cold replacement uses `PrepareUpdate` first; process shutdown uses this
    /// final catch-all before the capability broker itself stops.
    Shutdown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamMethod {
    Events,
    LogicIdentity,
    PatchControl,
    AssetPreview,
    ShellRun,
    RtcNegotiate,
    SpeechTranscribe,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StreamAuthorization {
    pub allowed: bool,
    #[serde(default)]
    pub missing_grant: Option<String>,
    /// A remote shell/command must be confined unless the guest explicitly
    /// says this caller holds `pty:unconfined`.
    #[serde(default)]
    pub confinement_required: bool,
    #[serde(default)]
    pub receive_pty: bool,
    #[serde(default)]
    pub receive_background_processes: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceExecution {
    pub cwd: FileLocator,
    pub roots: Vec<FileLocator>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceCatalog {
    pub generation: String,
    pub revision: u64,
    pub workspaces: Vec<CatalogWorkspace>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogWorkspace {
    pub local_workspace_id: String,
    pub reported_name: String,
    pub is_git_repo: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum PlatformReply {
    Authenticated {
        subject_id: String,
        proof: String,
        encryption_key: [u8; 32],
        context: String,
    },
    Claimed(DeviceCredential),
    WorkspaceCatalog(WorkspaceCatalog),
    WorkspaceFile(FileLocator),
    WorkspaceExecution(WorkspaceExecution),
    StreamAuthorization(StreamAuthorization),
    SpeechPrepared(SpeechConfig),
    UpdateReadiness(UpdateReadiness),
    Ack,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateReadiness {
    pub busy: bool,
    pub active_sessions: u32,
    pub terminals: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformCompletion {
    pub call_id: u64,
    pub result: Result<PlatformReply, ProtocolError>,
}

/// Final result of the portable application router.
///
/// There is deliberately no native fallback. A request is either answered by
/// the signed Wasm application or fails; the platform cannot silently regain
/// ownership of business policy when an artifact is missing or incomplete.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum LogicOutcome {
    Reply(Box<Reply>),
    Error(ProtocolError),
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicCompletion {
    pub call_id: u64,
    pub outcome: LogicOutcome,
    #[serde(default)]
    pub connection: ConnectionDirective,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicOutput {
    #[serde(default)]
    pub completions: Vec<LogicCompletion>,
    #[serde(default)]
    pub platform_completions: Vec<PlatformCompletion>,
    #[serde(default)]
    pub capability_batches: Vec<CapabilityBatch>,
    #[serde(default)]
    pub publications: Vec<Publication>,
}

impl LogicOutput {
    pub fn completed(call_id: u64, outcome: LogicOutcome) -> Self {
        Self {
            completions: vec![LogicCompletion {
                call_id,
                outcome,
                connection: ConnectionDirective::None,
            }],
            ..Self::default()
        }
    }
}

/// Connection-local transport work chosen by portable routing policy. Native
/// code owns the broadcast receiver, while the guest owns subscription and
/// sequence/resync semantics.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ConnectionDirective {
    #[default]
    None,
    Subscribe {
        session_id: String,
    },
    Unsubscribe {
        session_id: String,
    },
}

/// Product output that is not tied to one request/reply exchange.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum Publication {
    Session(SequencedEvent),
    Fanout(ServerFrame),
    DeviceRevoked { device_id: String },
}

/// Opaque response produced by the guest for one business RPC. The status is
/// stable HTTP-like carrier metadata; `body` and `error` remain exact JSON
/// bytes owned by the active protocol implementation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierResponse {
    pub status: u16,
    pub body: Vec<u8>,
    #[serde(default)]
    pub error: Option<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierCompletion {
    pub call_id: u64,
    pub response: CarrierResponse,
    #[serde(default)]
    pub connection: ConnectionDirective,
}

/// Native uses only these stable security classes to filter an opaque event.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PublicationSecurity {
    General,
    Pty,
    BackgroundProcesses,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CarrierPublication {
    Session {
        session_id: String,
        event: Vec<u8>,
    },
    Fanout {
        security: PublicationSecurity,
        frame: Vec<u8>,
    },
    DeviceRevoked {
        device_id: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CarrierOutput {
    #[serde(default)]
    pub completions: Vec<CarrierCompletion>,
    #[serde(default)]
    pub platform_completions: Vec<PlatformCompletion>,
    #[serde(default)]
    pub capability_batches: Vec<CapabilityBatch>,
    #[serde(default)]
    pub publications: Vec<CarrierPublication>,
}

/// A group of independent raw system operations. The guest emits one batch and
/// receives one batch result, making the boundary cost proportional to useful
/// I/O rather than to fields or strings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityBatch {
    pub batch_id: u64,
    pub calls: Vec<CapabilityCall>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityCall {
    pub call_id: u64,
    pub request: CapabilityRequest,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityResults {
    pub batch_id: u64,
    pub results: Vec<CapabilityResult>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityResult {
    pub call_id: u64,
    pub result: Result<CapabilityValue, CapabilityFailure>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityFailure {
    pub kind: CapabilityFailureKind,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapabilityFailureKind {
    Invalid,
    Denied,
    NotFound,
    Conflict,
    Unavailable,
    TooLarge,
    Internal,
}

/// Raw host operations only. Their arguments are resource handles, byte
/// buffers and OS-shaped values; GeneHub sessions, providers and update policy
/// deliberately do not appear here.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CapabilityRequest {
    /// Reads one explicitly named host environment value. This is a raw OS
    /// fact used for tool-owned configuration directories; interpretation and
    /// allowlisting remain in the signed guest.
    Environment {
        key: String,
        max_bytes: u32,
    },
    SecureRead {
        key: String,
        max_bytes: u32,
    },
    SecureWrite {
        key: String,
        bytes: Vec<u8>,
    },
    SecureRemove {
        key: String,
    },
    File(FileRequest),
    Process(ProcessRequest),
    Pty(PtyRequest),
    Http(HttpRequest),
    Socket(SocketRequest),
    Rtc(RtcRequest),
    /// Long-lived encrypted connectivity is an unavoidable native resource:
    /// it owns Tokio tasks and live carriers. The guest still owns RPC routing
    /// and invokes each operation as one bounded capability call.
    Connectivity(ConnectivityRequest),
    SpeechRuntime(SpeechRuntimeRequest),
    /// A bounded, privacy-safe snapshot of native carrier/runtime facts. The
    /// guest decides whether and when this is exposed as a product reply.
    Diagnostics,
    Random {
        bytes: u32,
    },
    Clock,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CapabilityValue {
    Unit,
    Bytes(Vec<u8>),
    Text(String),
    Clock {
        unix_millis: i64,
        monotonic_millis: u64,
    },
    FileEntries(Vec<FileEntry>),
    FileMetadata(FileMetadata),
    FileLocator(FileLocator),
    FileLocked {
        resource_id: u64,
    },
    Resource {
        resource_id: u64,
    },
    ProcessStarted {
        resource_id: u64,
        pid: Option<u32>,
    },
    ProcessExit {
        code: Option<i32>,
    },
    ProcessCompleted {
        code: Option<i32>,
        stdout: Vec<u8>,
        stderr: Vec<u8>,
    },
    ProcessCensus(Vec<ProcessCensusRow>),
    Http(HttpResponse),
    RtcDescription {
        kind: RtcDescriptionKind,
        sdp: String,
    },
    HubStatus(HubStatus),
    HubClaim {
        status: HubStatus,
        claim: HubClaim,
    },
    HubMachines(Vec<HubMachine>),
    HubTicket(HubTicket),
    RemoteAccess(RemoteAccess),
    Diagnostics(SupportDiagnostics),
    SpeechCapabilities(SpeechCapabilities),
    SpeechRuntimeStatus(SpeechRuntimeStatus),
    SpeechRuntimeConfig(SpeechRuntimeConfig),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum SpeechRuntimeRequest {
    Capabilities { config: SpeechConfig },
    Probe { config: SpeechConfig },
    ValidateRegistration { command: String, args: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ConnectivityRequest {
    HubStatus,
    HubPair {
        hub_url: String,
        display_name: Option<String>,
    },
    HubTrial {
        hub_url: String,
        display_name: Option<String>,
    },
    HubClaimLink,
    HubMachines,
    HubConnect {
        machine_id: String,
    },
    HubUnpair,
    RemoteStatus,
    RemoteAttach {
        relay_url: String,
        join_token: Option<String>,
    },
    RemoteDetach,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum CapabilityEvent {
    ProcessOutput {
        resource_id: u64,
        stream: ProcessStream,
        bytes: Vec<u8>,
    },
    ProcessExited {
        resource_id: u64,
        code: Option<i32>,
    },
    PtyOutput {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    PtyClosed {
        resource_id: u64,
        code: Option<i32>,
    },
    SocketMessage {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    SocketClosed {
        resource_id: u64,
        reason: String,
    },
    RtcMessage {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    RtcOpened {
        resource_id: u64,
    },
    RtcClosed {
        resource_id: u64,
        reason: String,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum FileRequest {
    /// Enumerates OS volume roots for the native file picker. This cannot be
    /// compiled into the Linux-built guest because the answer is host-specific.
    MachineRoots,
    RegisterWorkspaceRoot {
        handle: String,
        native_path: String,
    },
    UnregisterWorkspaceRoot {
        handle: String,
    },
    Read {
        locator: FileLocator,
        max_bytes: u32,
    },
    ReadTail {
        locator: FileLocator,
        max_bytes: u32,
    },
    ReadRange {
        locator: FileLocator,
        offset: u64,
        length: u32,
    },
    /// Acquires a kernel-backed advisory lock and keeps its file handle in the
    /// native resource table for this guest instance. Cold replacement drains
    /// it; the next guest reacquires locks from durable domain metadata.
    Lock {
        locator: FileLocator,
        exclusive: bool,
    },
    Unlock {
        resource_id: u64,
    },
    WriteAtomic {
        locator: FileLocator,
        bytes: Vec<u8>,
    },
    Append {
        locator: FileLocator,
        bytes: Vec<u8>,
    },
    List {
        locator: FileLocator,
    },
    Metadata {
        locator: FileLocator,
    },
    CreateDirAll {
        locator: FileLocator,
    },
    RemoveFile {
        locator: FileLocator,
    },
    RemoveDirAll {
        locator: FileLocator,
    },
    Rename {
        from: FileLocator,
        to: FileLocator,
    },
    Copy {
        from: FileLocator,
        to: FileLocator,
    },
    CanonicalizeHostPath {
        path: String,
    },
    ResolveHostPath {
        base: String,
        path: String,
    },
    /// Resolves an optional native/relative cwd against a guest-supplied set
    /// of registered workspace roots and returns an opaque rooted locator.
    ResolveWorkspacePath {
        roots: Vec<WorkspaceRootPath>,
        default_handle: String,
        #[serde(default)]
        path: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceRootPath {
    pub handle: String,
    pub native_path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileLocator {
    pub root: FileRoot,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum FileRoot {
    Private,
    Logs,
    Workspace { handle: String },
    NativePath,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileEntry {
    pub name: String,
    pub kind: FileKind,
    pub bytes: u64,
    pub modified_at_millis: Option<i64>,
    #[serde(default)]
    pub native_path: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMetadata {
    pub kind: FileKind,
    pub bytes: u64,
    pub modified_at_millis: Option<i64>,
    pub canonical_path: Option<String>,
    #[serde(default)]
    pub parent_path: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub extension: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileKind {
    File,
    Directory,
    Symlink,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ProcessRequest {
    /// Resolves a native executable exactly as process launch would, including
    /// `PATH` and Windows `PATHEXT`, without starting it.
    ResolveProgram {
        program: String,
    },
    Run {
        spec: ProcessSpec,
        stdin: Vec<u8>,
        timeout_millis: u32,
        max_stdout_bytes: u32,
        max_stderr_bytes: u32,
    },
    /// Runs a bounded byte-stream dialogue. The guest owns every protocol
    /// frame and completion marker; native code only writes bytes and waits
    /// for a matching stdout line before advancing to the next step.
    Dialogue {
        spec: ProcessSpec,
        steps: Vec<ProcessDialogueStep>,
        timeout_millis: u32,
        max_stdout_bytes: u32,
        max_stderr_bytes: u32,
    },
    Spawn(ProcessSpec),
    Write {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    CloseInput {
        resource_id: u64,
    },
    Signal {
        resource_id: u64,
        signal: ProcessSignal,
    },
    Poll {
        resource_id: u64,
    },
    /// Raw host process table. Ownership attribution remains in the guest.
    Census,
    /// Raw tree termination after the guest has matched the pid against a
    /// fresh census and a session-owned agent process.
    EndTree {
        pid: u32,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessDialogueStep {
    pub stdin: Vec<u8>,
    /// A byte sequence that must occur in one complete stdout line before the
    /// following step is written. Empty markers are rejected.
    pub wait_for_line: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessCensusRow {
    pub pid: u32,
    pub parent_pid: u32,
    pub group_id: u32,
    pub running_for_seconds: u64,
    pub command: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<FileLocator>,
    #[serde(default)]
    pub confinement: ConfinementMode,
    pub capture_stdout: bool,
    pub capture_stderr: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum ConfinementMode {
    #[default]
    None,
    Workspace {
        roots: Vec<FileLocator>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessSignal {
    Interrupt,
    Terminate,
    KillTree,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum PtyRequest {
    Open {
        cwd: FileLocator,
        #[serde(default)]
        confinement: ConfinementMode,
        cols: u16,
        rows: u16,
        env: BTreeMap<String, String>,
    },
    Write {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    Resize {
        resource_id: u64,
        cols: u16,
        rows: u16,
    },
    Close {
        resource_id: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub timeout_millis: u32,
    pub max_response_bytes: u32,
    pub redirect: RedirectPolicy,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RedirectPolicy {
    None,
    SameOrigin,
    HttpsOnly { max_hops: u8 },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum SocketRequest {
    Connect {
        url: String,
        headers: Vec<(String, String)>,
        max_message_bytes: u32,
    },
    Send {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    Close {
        resource_id: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum RtcRequest {
    Create {
        ice_servers: Vec<String>,
        data_channel_label: String,
        max_message_bytes: u32,
    },
    SetRemoteDescription {
        resource_id: u64,
        kind: RtcDescriptionKind,
        sdp: String,
    },
    CreateAnswer {
        resource_id: u64,
    },
    Send {
        resource_id: u64,
        bytes: Vec<u8>,
    },
    Close {
        resource_id: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RtcDescriptionKind {
    Offer,
    Answer,
}
