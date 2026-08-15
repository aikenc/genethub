//! Stable application messages crossing the daemon platform/Wasm boundary.
//!
//! The ABI itself moves one bounded byte buffer in and one bounded byte buffer
//! out per event. These types describe those buffers; individual strings never
//! become host calls, which keeps the native platform independent of business
//! schemas and avoids chatty FFI.

use std::collections::BTreeMap;

use genehub_proto::{
    DeviceAuth, DeviceCredential, HubClaim, HubMachine, HubStatus, HubTicket, InviteAuth,
    ProtocolError, RemoteAccess, Reply, Request, SequencedEvent, ServerFrame, TransportKind,
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
pub const ABI_VERSION: u32 = 11;
pub const SNAPSHOT_FORMAT_VERSION: u32 = 4;
pub const MAX_CAPABILITY_BATCH: usize = 64;
pub const MAX_CAPABILITY_CHUNK_BYTES: usize = 3 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicBoot {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub machine_id: String,
    pub fingerprint: String,
    pub machine_name: String,
    pub rtc_supported: bool,
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicRequest {
    /// Native-call correlation only. It is opaque to product clients and lets
    /// one guest instance suspend multiple requests on batched capabilities.
    pub call_id: u64,
    pub transport: TransportKind,
    pub request: Request,
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

/// Native transport asks the signed application to make a security decision
/// through the same bounded byte ABI as ordinary RPC. The platform still owns
/// sockets and AEAD records; authorization state and replay policy stay hot
/// updateable inside the guest.
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
    Ack,
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
/// code owns the broadcast receiver, while the guest owns what is subscribed
/// and the snapshot/replay semantics.
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
    Random {
        bytes: u32,
    },
    Clock,
    LogicArtifact(LogicArtifactRequest),
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
    LogicArtifact(LogicArtifactState),
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
    /// native resource table. The opaque id survives guest hot replacement.
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
    CanonicalizeHostPath {
        path: String,
    },
    ResolveHostPath {
        base: String,
        path: String,
    },
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
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProcessSpec {
    pub program: String,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub cwd: Option<FileLocator>,
    pub capture_stdout: bool,
    pub capture_stderr: bool,
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum LogicArtifactRequest {
    Status,
    Install { native_path: String },
    Rollback,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicArtifactState {
    pub version: String,
    pub digest: String,
    pub origin: String,
    pub generation: u64,
}
