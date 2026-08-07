//! Typed RPC operations and event payloads carried inside protocol-v3
//! Exchanges. This module is a business schema, not a connection envelope.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::domain::*;
use crate::event::{PermissionOutcome, SequencedEvent};
use crate::timeline::Attachment;

/// Bumped when a change would break an older client. Clients that see a version
/// they do not know must refuse to connect rather than guess.
pub const PROTOCOL_VERSION: u32 = crate::data::DATA_PLANE_VERSION;
/// Maximum typed RPC body accepted before it is divided into bounded v3 data
/// frames.
pub const MAX_RPC_BODY_BYTES: usize = 2_900_000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "payload", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum Request {
    /// Returns machine metadata only after the channel key is active, so a
    /// forwarding service cannot read a user's alias or fingerprint.
    #[serde(rename = "connection.identity")]
    ConnectionIdentity,
    /// Subscribe to a session's events. `sinceSeq` asks for a replay of
    /// everything after that sequence number.
    #[serde(rename = "subscribe", rename_all = "camelCase")]
    Subscribe {
        session_id: String,
        #[serde(default)]
        #[ts(type = "number")]
        since_seq: Option<u64>,
        /// Prefetches the last round's trunk index and final trunk details in
        /// the subscription response.
        #[serde(default)]
        expand_last_round: bool,
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
    #[serde(rename = "round.trunk.list", rename_all = "camelCase")]
    RoundTrunkList {
        session_id: String,
        round_id: String,
        #[serde(default)]
        cursor: Option<String>,
        #[serde(default)]
        limit: Option<u32>,
    },
    #[serde(rename = "round.trunk.get", rename_all = "camelCase")]
    RoundTrunkGet {
        session_id: String,
        round_id: String,
        trunk_index: u32,
    },
    /// Fetches one blob's full payload. The client hands back the whole
    /// `BlobRef` it was given rather than just an id, because the locator is
    /// what makes this a seek instead of a scan (`docs/session-storage.md`).
    #[serde(rename = "blob.get", rename_all = "camelCase")]
    BlobGet { session_id: String, blob: BlobRef },
    #[serde(rename = "session.send", rename_all = "camelCase")]
    SessionSend {
        session_id: String,
        text: String,
        #[serde(default)]
        attachments: Vec<Attachment>,
        /// Claims this message as a continuation of a round left open by an
        /// interrupt, rather than a new one. Only interrupts need this: the
        /// daemon auto-stitches approval and guidance continuations on its
        /// own, because those are unambiguous (`docs/architecture.md`'s
        /// analysis substrate proposal §3.2). Absent, unknown, or naming a
        /// round that already ended, this is treated as a new round — a
        /// wrong stitch is a worse failure than an extra round.
        #[serde(default)]
        continues_round: Option<String>,
    },
    #[serde(rename = "session.fork", rename_all = "camelCase")]
    SessionFork { session_id: String, turn_id: String },
    #[serde(rename = "session.interrupt", rename_all = "camelCase")]
    SessionInterrupt { session_id: String },
    #[serde(rename = "session.close", rename_all = "camelCase")]
    SessionClose { session_id: String },
    #[serde(rename = "session.archive", rename_all = "camelCase")]
    SessionArchive { session_id: String, archived: bool },
    /// Renames a session, replacing whatever the daemon named it.
    ///
    /// Separate from archiving because the two answer different questions. A
    /// title the user typed also stops the daemon renaming it later from the
    /// first message: being overwritten a second after typing it is the one
    /// outcome that would make this feature untrustworthy.
    #[serde(rename = "session.rename", rename_all = "camelCase")]
    SessionRename { session_id: String, title: String },
    /// Erases a session: its timeline, its metadata and its scratch space.
    ///
    /// Not `archive`, which only hides. There is no undo and no bin — a
    /// conversation people want gone is usually one with something in it they
    /// would rather not keep, and a "deleted" that quietly keeps the file is a
    /// lie about that.
    #[serde(rename = "session.delete", rename_all = "camelCase")]
    SessionDelete { session_id: String },
    #[serde(rename = "session.setModel", rename_all = "camelCase")]
    SessionSetModel {
        session_id: String,
        model_id: String,
    },
    #[serde(rename = "session.setMode", rename_all = "camelCase")]
    SessionSetMode { session_id: String, mode_id: String },
    #[serde(rename = "session.setEffort", rename_all = "camelCase")]
    SessionSetEffort {
        session_id: String,
        effort_id: String,
    },
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
        /// What to call it on screen, for a provider the user is adding.
        #[serde(default)]
        label: Option<String>,
        /// `openai` | `anthropic`, when the address does not belong to a
        /// provider we already know the shape of.
        #[serde(default)]
        dialect: Option<String>,
        /// Models by hand, for an endpoint that cannot list its own.
        #[serde(default)]
        models: Option<Vec<String>>,
    },

    /// Removes a provider the user added, key and all.
    #[serde(rename = "settings.forgetProvider", rename_all = "camelCase")]
    SettingsForgetProvider { provider_id: String },

    /// The end of a log file on this machine.
    ///
    /// Served over the connection rather than pointed at, because the person who
    /// needs it is often not sitting at the machine: a path under
    /// `C:\\Users\\...\\GeneHub\\logs` is no use on a phone. `name` is a file in
    /// the log directory and nothing else — see `logs::tail`.
    #[serde(rename = "log.tail", rename_all = "camelCase")]
    LogTail {
        /// Omitted means the daemon's own log, which is what an error is about
        /// almost every time.
        #[serde(default)]
        name: Option<String>,
    },

    // -- updates -----------------------------------------------------------
    /// Whether a newer build has been published. Sent when a person asks, and
    /// never on a timer — see `UpdateStatus`.
    #[serde(rename = "update.check")]
    UpdateCheck,
    /// Fetches the installer for this platform into the machine's own data
    /// directory. Answers with the state at that moment; the rest arrives as
    /// `ServerFrame::UpdateDownload` pushes.
    #[serde(rename = "update.download")]
    UpdateDownload,
    /// How far a fetch got, for a client that arrived after it started.
    #[serde(rename = "update.downloadState")]
    UpdateDownloadState,
    /// Forgets a finished or failed fetch, so the prompt stops asking.
    ///
    /// The file stays on disk: "稍后" means later, not never, and re-downloading
    /// a hundred megabytes because someone closed a toast is a punishment for
    /// reading it.
    #[serde(rename = "update.dismiss")]
    UpdateDismiss,

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
    /// Every machine belonging to this machine's owner, as the Hub sees them.
    ///
    /// Asked of the daemon rather than of the Hub, because the client is one
    /// program that talks to one daemon and holds no account credential of its
    /// own. The daemon already has the strongest proof of ownership there is
    /// without a browser — its uplink credential — and already may exchange it
    /// for one of the owner's device sessions (`hub.claimLink`). Reading the
    /// owner's machine list with it is therefore not a new permission.
    #[serde(rename = "hub.machines")]
    HubMachines,
    /// A one-time address for reaching one of them through the forwarding
    /// layer. Called again on every reconnect, because a ticket is spent by
    /// the connection that used it.
    #[serde(rename = "hub.connect", rename_all = "camelCase")]
    HubConnect { machine_id: String },
    /// Drops the enrollment and the uplink with it. The machine keeps working
    /// locally; it just stops being reachable from outside.
    #[serde(rename = "hub.unpair")]
    HubUnpair,

    // -- devices -----------------------------------------------------------
    /// Who is allowed to reach this machine, and whether remote access is on.
    #[serde(rename = "device.list")]
    DeviceList,
    /// Mints a one-time invite to show as a link and a QR code.
    ///
    /// The new device names itself when it redeems the invite — it is the one
    /// that knows whether it is a phone or a laptop.
    #[serde(rename = "device.invite")]
    DeviceInvite,
    /// Redeems an invite. The only request a stranger may send, and only once
    /// per invite: everything else needs a credential this call hands out.
    #[serde(rename = "device.claim", rename_all = "camelCase")]
    DeviceClaim { code: String, device_name: String },
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
    #[serde(rename = "workspace.rename", rename_all = "camelCase")]
    WorkspaceRename { workspace_id: String, name: String },
    /// Lists folders on the daemon's machine before a workspace exists.
    #[serde(rename = "directory.list", rename_all = "camelCase")]
    DirectoryList {
        #[serde(default)]
        path: Option<String>,
    },

    // -- files -------------------------------------------------------------
    #[serde(rename = "file.tree", rename_all = "camelCase")]
    FileTree {
        workspace_id: String,
        #[serde(default)]
        path: Option<String>,
        #[serde(default)]
        depth: Option<u32>,
    },
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
    HubMachines(Vec<HubMachine>),
    HubTicket(HubTicket),
    #[serde(rename_all = "camelCase")]
    Devices {
        devices: Vec<DeviceInfo>,
        remote: RemoteAccess,
    },
    Invite(DeviceInvite),
    Claimed(DeviceCredential),
    RemoteAccess(RemoteAccess),
    Settings(Settings),
    Log(LogTail),
    Update(UpdateStatus),
    UpdateDownload(UpdateDownload),
    Session(SessionSummary),
    Sessions(Vec<SessionSummary>),
    Snapshot(SessionSnapshot),
    RoundLayer(RoundLayer),
    RoundTrunk(RoundTrunk),
    Blob(BlobPayload),
    Workspace(WorkspaceInfo),
    Workspaces(Vec<WorkspaceInfo>),
    Directory(DirectoryListing),
    FileTree(FileNode),
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DirectoryListing {
    pub path: String,
    pub parent: Option<String>,
    pub directories: Vec<DirectoryEntry>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct DirectoryEntry {
    pub name: String,
    pub path: String,
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
    /// How far the installer fetch has got.
    ///
    /// Pushed to every client rather than answered to the one that asked: a
    /// download started from the settings page has to keep reporting itself
    /// after that page is closed, and a second window must not show a stale
    /// "下载中" forever.
    #[serde(rename = "updateDownload", rename_all = "camelCase")]
    UpdateDownloadChanged { download: UpdateDownload },
    /// This connection fell behind and events for a session were dropped.
    ///
    /// Addressed to the client rather than to the person: a hole in a timeline is
    /// not something to apologise for in prose, it is something to go and fetch.
    /// The client already knows how — the same `subscribe` with its last sequence
    /// number that it does after a reconnect.
    #[serde(rename = "desync", rename_all = "camelCase")]
    Desync {
        session_id: String,
        // JSON has one number type, and this travels as JSON: calling it a
        // bigint on the other side would describe a value that cannot arrive.
        #[ts(type = "number")]
        missed: u64,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum NoticeLevel {
    Info,
    Warning,
    Error,
}

impl ServerFrame {
    pub fn event(session_id: &str, event: SequencedEvent) -> Self {
        ServerFrame::Event {
            topic: format!("session:{session_id}"),
            payload: event,
        }
    }
}
