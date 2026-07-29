//! The client protocol envelope: requests in, results and pushes out.
//!
//! One shape serves all three transports in `daemon.md` §3.1. Only
//! authentication differs between loopback, LAN and forwarded connections.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::domain::*;
use crate::event::{PermissionOutcome, SequencedEvent};
use crate::timeline::Attachment;

/// Bumped when a change would break an older client. Clients that see a version
/// they do not know must refuse to connect rather than guess.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum Request {
    // -- handshake ---------------------------------------------------------
    #[serde(rename = "hello", rename_all = "camelCase")]
    Hello {
        client_name: String,
        protocol_version: u32,
        /// Present when the client holds a device credential for this machine.
        /// Required on forwarded connections: the machine decides admission
        /// itself, and a relay vouches for nobody.
        #[serde(default)]
        device: Option<DeviceAuth>,
    },
    /// Subscribe to a session's events. `sinceSeq` asks for a replay of
    /// everything after that sequence number.
    #[serde(rename = "subscribe", rename_all = "camelCase")]
    Subscribe {
        session_id: String,
        #[serde(default)]
        #[ts(type = "number")]
        since_seq: Option<u64>,
    },
    #[serde(rename = "unsubscribe", rename_all = "camelCase")]
    Unsubscribe { session_id: String },

    // -- agents ------------------------------------------------------------
    #[serde(rename = "agent.list")]
    AgentList,
    /// Re-probe the machine. Used after the user installs an agent so they do
    /// not have to restart anything.
    #[serde(rename = "agent.refresh")]
    AgentRefresh,

    // -- sessions ----------------------------------------------------------
    #[serde(rename = "session.create", rename_all = "camelCase")]
    SessionCreate {
        workspace_id: String,
        agent_id: String,
        #[serde(default)]
        model_id: Option<String>,
        #[serde(default)]
        mode_id: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },
    #[serde(rename = "session.list", rename_all = "camelCase")]
    SessionList {
        #[serde(default)]
        workspace_id: Option<String>,
        #[serde(default)]
        include_archived: bool,
    },
    #[serde(rename = "session.get", rename_all = "camelCase")]
    SessionGet { session_id: String },
    #[serde(rename = "session.send", rename_all = "camelCase")]
    SessionSend {
        session_id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<Attachment>,
    },
    #[serde(rename = "session.interrupt", rename_all = "camelCase")]
    SessionInterrupt { session_id: String },
    #[serde(rename = "session.close", rename_all = "camelCase")]
    SessionClose { session_id: String },
    #[serde(rename = "session.archive", rename_all = "camelCase")]
    SessionArchive { session_id: String, archived: bool },
    #[serde(rename = "session.setModel", rename_all = "camelCase")]
    SessionSetModel {
        session_id: String,
        model_id: String,
    },
    #[serde(rename = "session.setMode", rename_all = "camelCase")]
    SessionSetMode { session_id: String, mode_id: String },
    #[serde(rename = "session.respondPermission", rename_all = "camelCase")]
    SessionRespondPermission {
        session_id: String,
        request_id: String,
        outcome: PermissionOutcome,
    },

    // -- settings ----------------------------------------------------------
    #[serde(rename = "settings.get")]
    SettingsGet,
    /// Stores a provider credential on the machine.
    ///
    /// Write-only by design: the value never comes back out, so a client that
    /// gets read access later cannot exfiltrate keys it did not already have.
    #[serde(rename = "settings.setProvider", rename_all = "camelCase")]
    SettingsSetProvider {
        provider_id: String,
        /// `None` leaves the stored key alone; an empty string clears it.
        #[serde(default)]
        api_key: Option<String>,
        #[serde(default)]
        base_url: Option<String>,
    },

    // -- hub ---------------------------------------------------------------
    /// Whether this machine is paired, and how far a pairing in progress got.
    #[serde(rename = "hub.status")]
    HubStatus,
    /// Begins the device code flow. Returns as soon as there is a code to show;
    /// approval happens in a browser and completes in the background.
    #[serde(rename = "hub.pair", rename_all = "camelCase")]
    HubPair {
        hub_url: String,
        #[serde(default)]
        display_name: Option<String>,
    },
    /// Pairs with a temporary identity the Hub creates on the spot, so trying
    /// the product does not start with a sign-up form.
    #[serde(rename = "hub.trial", rename_all = "camelCase")]
    HubTrial {
        hub_url: String,
        #[serde(default)]
        display_name: Option<String>,
    },
    /// A fresh one-time link into this machine's identity, to open elsewhere.
    #[serde(rename = "hub.claimLink")]
    HubClaimLink,
    /// Drops the enrollment and the uplink with it. The machine keeps working
    /// locally; it just stops being reachable from outside.
    #[serde(rename = "hub.unpair")]
    HubUnpair,

    // -- devices -----------------------------------------------------------
    /// Who is allowed to reach this machine, and whether remote access is on.
    #[serde(rename = "device.list")]
    DeviceList,
    /// Mints a one-time invite to show as a link and a QR code.
    #[serde(rename = "device.invite", rename_all = "camelCase")]
    DeviceInvite {
        #[serde(default)]
        name: Option<String>,
    },
    /// Redeems an invite. The only request a stranger may send, and only once
    /// per invite: everything else needs a credential this call hands out.
    #[serde(rename = "device.claim", rename_all = "camelCase")]
    DeviceClaim {
        code: String,
        device_name: String,
        nonce: String,
        proof: String,
    },
    /// Forgets a device. Its live connection drops with it.
    #[serde(rename = "device.revoke", rename_all = "camelCase")]
    DeviceRevoke { device_id: String },
    /// Starts meeting clients at a rendezvous relay.
    #[serde(rename = "device.remoteAttach", rename_all = "camelCase")]
    DeviceRemoteAttach {
        relay_url: String,
        #[serde(default)]
        join_token: Option<String>,
    },
    /// Stops being reachable from outside. Authorized devices stay authorized.
    #[serde(rename = "device.remoteDetach")]
    DeviceRemoteDetach,

    // -- workspaces --------------------------------------------------------
    #[serde(rename = "workspace.list")]
    WorkspaceList,
    #[serde(rename = "workspace.open", rename_all = "camelCase")]
    WorkspaceOpen { root: String },
    #[serde(rename = "workspace.create", rename_all = "camelCase")]
    WorkspaceCreate { root: String, name: String },

    // -- files -------------------------------------------------------------
    #[serde(rename = "file.tree", rename_all = "camelCase")]
    FileTree {
        workspace_id: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        depth: Option<u32>,
    },
    #[serde(rename = "file.read", rename_all = "camelCase")]
    FileRead { workspace_id: String, path: String },
    #[serde(rename = "file.write", rename_all = "camelCase")]
    FileWrite {
        workspace_id: String,
        path: String,
        content: String,
    },

    // -- git ---------------------------------------------------------------
    #[serde(rename = "git.status", rename_all = "camelCase")]
    GitStatus { workspace_id: String },
    #[serde(rename = "git.diff", rename_all = "camelCase")]
    GitDiff {
        workspace_id: String,
        #[serde(default)]
        path: Option<String>,
    },
    #[serde(rename = "git.commit", rename_all = "camelCase")]
    GitCommit {
        workspace_id: String,
        message: String,
        /// Empty means "everything currently changed".
        #[serde(default)]
        paths: Vec<String>,
    },

    // -- terminal ----------------------------------------------------------
    #[serde(rename = "pty.open", rename_all = "camelCase")]
    PtyOpen {
        workspace_id: String,
        #[serde(default)]
        cols: Option<u16>,
        #[serde(default)]
        rows: Option<u16>,
    },
    #[serde(rename = "pty.write", rename_all = "camelCase")]
    PtyWrite { pty_id: String, data: String },
    #[serde(rename = "pty.resize", rename_all = "camelCase")]
    PtyResize {
        pty_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename = "pty.close", rename_all = "camelCase")]
    PtyClose { pty_id: String },
}

/// Successful payloads, one per request that returns something.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum Reply {
    Hello(HelloResult),
    /// A subscribe always answers with a snapshot plus any replayed events, so
    /// the client has exactly one code path for "catch up".
    #[serde(rename_all = "camelCase")]
    Subscribed {
        snapshot: SessionSnapshot,
        replayed: Vec<SequencedEvent>,
        /// True when the requested `sinceSeq` fell outside the retained window
        /// and the snapshot is a full reset rather than a continuation.
        reset: bool,
    },
    Agents(Vec<AgentInfo>),
    HubStatus(HubStatus),
    #[serde(rename_all = "camelCase")]
    HubClaim {
        status: HubStatus,
        claim: HubClaim,
    },
    #[serde(rename_all = "camelCase")]
    Devices {
        devices: Vec<DeviceInfo>,
        remote: RemoteAccess,
    },
    Invite(DeviceInvite),
    Claimed(DeviceCredential),
    RemoteAccess(RemoteAccess),
    Settings(Settings),
    Session(SessionSummary),
    Sessions(Vec<SessionSummary>),
    Snapshot(SessionSnapshot),
    Workspace(WorkspaceInfo),
    Workspaces(Vec<WorkspaceInfo>),
    FileTree(FileNode),
    FileContent(FileContent),
    GitStatus(GitStatus),
    #[serde(rename_all = "camelCase")]
    GitDiff {
        diff: String,
    },
    #[serde(rename_all = "camelCase")]
    GitCommit {
        commit: String,
    },
    #[serde(rename_all = "camelCase")]
    Pty {
        pty_id: String,
    },
    /// Nothing to return, but the call succeeded.
    Ack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ErrorCode {
    BadRequest,
    Unauthorized,
    NotFound,
    Conflict,
    /// The target agent does not have this capability. Clients should have hid
    /// the control; getting this back means the capability data was stale.
    Unsupported,
    /// Path escaped its workspace, or a workspace was never registered.
    Forbidden,
    Internal,
    ProtocolVersion,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

/// Anything the daemon sends to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ServerFrame {
    /// Answer to a request, correlated by the request's `id`.
    #[serde(rename = "result", rename_all = "camelCase")]
    Result {
        id: String,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        payload: Option<Reply>,
        #[serde(skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        error: Option<ProtocolError>,
    },
    /// A session event push. `topic` is `session:<id>`.
    #[serde(rename = "event", rename_all = "camelCase")]
    Event {
        topic: String,
        payload: SequencedEvent,
    },
    /// Terminal output. Kept off the session event stream because it is high
    /// frequency and belongs straight in the terminal widget.
    #[serde(rename = "pty", rename_all = "camelCase")]
    PtyOutput { pty_id: String, data: String },
    #[serde(rename = "ptyClosed", rename_all = "camelCase")]
    PtyClosed {
        pty_id: String,
        #[ts(optional)]
        exit_code: Option<i32>,
    },
    /// Unsolicited notice, e.g. the machine was revoked by the Hub.
    #[serde(rename = "notice", rename_all = "camelCase")]
    Notice { level: NoticeLevel, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

/// A request as it arrives on the wire: an envelope id plus the request body.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "index.ts")]
pub struct ClientEnvelope {
    pub id: String,
    #[serde(flatten)]
    pub request: Request,
}

impl ServerFrame {
    pub fn ok(id: impl Into<String>, payload: Reply) -> Self {
        ServerFrame::Result {
            id: id.into(),
            ok: true,
            payload: Some(payload),
            error: None,
        }
    }

    pub fn err(id: impl Into<String>, code: ErrorCode, message: impl Into<String>) -> Self {
        ServerFrame::Result {
            id: id.into(),
            ok: false,
            payload: None,
            error: Some(ProtocolError {
                code,
                message: message.into(),
            }),
        }
    }

    pub fn event(session_id: &str, event: SequencedEvent) -> Self {
        ServerFrame::Event {
            topic: format!("session:{session_id}"),
            payload: event,
        }
    }
}

/// Parses an incoming frame, keeping malformed input recoverable.
///
/// A parse failure must still be answerable, so the envelope id is extracted
/// separately: otherwise a client that sends one bad field would hang forever
/// waiting for a reply that has nowhere to go.
pub fn parse_envelope(raw: &str) -> Result<ClientEnvelope, (Option<String>, ProtocolError)> {
    let value: Value = serde_json::from_str(raw).map_err(|e| {
        (
            None,
            ProtocolError {
                code: ErrorCode::BadRequest,
                message: format!("malformed JSON: {e}"),
            },
        )
    })?;
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    serde_json::from_value(value).map_err(|e| {
        (
            id,
            ProtocolError {
                code: ErrorCode::BadRequest,
                message: e.to_string(),
            },
        )
    })
}
