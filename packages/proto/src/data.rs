//! The current endpoint-to-endpoint data-plane contract.
//!
//! Business operations are carried by independent logical streams.  This
//! module owns the small, versioned heads used by those streams; the binary
//! frame codec itself lives beside each transport implementation and is pinned
//! by cross-language golden vectors.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::domain::IsolationBackend;
use crate::rpc::ProtocolError;

/// A clean break from the former connection-wide JSON request protocol.
pub const DATA_PLANE_VERSION: u32 = 3;
/// Complete GeneHub record, before the WebSocket or DataChannel wrapper.
pub const MAX_DATA_FRAME_BYTES: usize = 16 * 1024;
pub const MAX_EXCHANGE_HEAD_BYTES: usize = 8 * 1024;
pub const INITIAL_STREAM_WINDOW_BYTES: u32 = 256 * 1024;
pub const MAX_ACTIVE_DATA_STREAMS: usize = 256;
/// A finite exchange is deliberately small; indefinite event streams omit a
/// body length and remain bounded by stream credit instead.
pub const MAX_FINITE_EXCHANGE_BODY_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PREVIEW_SOURCE_BYTES: usize = 4 * 1024 * 1024;
const _: () = assert!(MAX_EXCHANGE_HEAD_BYTES < MAX_DATA_FRAME_BYTES);

/// How a peer proves possession of an end-to-end secret during carrier setup.
///
/// Only a capability *name* is present for hosted sessions.  The daemon
/// redeems that name directly with Control; the Relay never receives the
/// secret.  Loopback uses the one-use proof delivered by the owner-only shell
/// as its short-lived PSK.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PeerAuth {
    #[serde(rename_all = "camelCase")]
    Loopback {
        context: String,
        nonce: String,
        proof: String,
    },
    #[serde(rename_all = "camelCase")]
    Device {
        device_id: String,
        nonce: String,
        proof: String,
    },
    #[serde(rename_all = "camelCase")]
    Hosted {
        capability_id: String,
        nonce: String,
        proof: String,
    },
    #[serde(rename_all = "camelCase")]
    Invite {
        invite_id: String,
        nonce: String,
        proof: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PeerHello {
    pub version: u32,
    pub client_name: String,
    pub auth: PeerAuth,
    /// Capability advertisement only.  Signaling remains encrypted data-plane
    /// traffic and no RTC address is ever placed in this hello.
    pub rtc_supported: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PeerWelcome {
    pub version: u32,
    pub server_nonce: String,
    pub proof: String,
}

/// Non-trickle RTC signaling carried inside an already E2EE Exchange.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RtcNegotiationRequest {
    pub sdp: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct RtcNegotiationResponse {
    pub sdp: String,
    pub capability_id: String,
    pub secret: String,
}

/// The first encrypted record on a client-opened logical stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ExchangeRequestHead {
    pub version: u32,
    pub method: String,
    #[serde(default)]
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub body_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timeout_ms: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ExchangeResponseHead {
    pub status: u16,
    #[serde(default)]
    pub metadata: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    #[ts(type = "number")]
    pub body_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct WorkspaceFileSource {
    pub kind: WorkspaceFileSourceKind,
    pub workspace_handle: String,
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum WorkspaceFileSourceKind {
    WorkspaceFile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AssetPreviewRequest {
    pub source: WorkspaceFileSource,
    /// Opaque per-operation id used only to correlate the browser and daemon's
    /// bounded diagnostic rings. It carries no account, workspace or path data.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub diagnostic_id: Option<String>,
}

/// What to run on a machine, and where.
///
/// `argv` is a list, never a command line: the machine does not parse it, so
/// nothing in it can turn into a second command. A caller that wants a shell's
/// help says so out loud with `["bash", "-lc", "..."]`, and that is then
/// visibly a shell rather than something that became one by quoting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
/// The request body, if there is one, is the command's standard input. It is
/// sent whole rather than as it is typed, because a single exchange cannot
/// carry a conversation: a command that reads, prints a question and reads
/// again needs the answer to depend on the question, and that is a terminal
/// (`pty.open`), not this. What this covers is the input that was already
/// decided before the command started — a patch, a here-document, the output
/// of something else in a pipeline.
pub struct ShellRunRequest {
    pub workspace_id: String,
    pub argv: Vec<String>,
    /// Somewhere inside the workspace. Absent means its root.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cwd: Option<String>,
    /// Added to the environment the daemon runs with, overriding it name by
    /// name.
    ///
    /// Additions only: there is no way to ask for a cleared environment. A
    /// command that loses `PATH` and `HOME` fails in ways that look like the
    /// machine is broken, and this grants no authority that choosing the argv
    /// did not already grant — the caller could have run `env FOO=bar ...`
    /// itself.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// How long the command may run before it is ended, in milliseconds.
    ///
    /// Absent means no limit, which is not what a one-shot tool call would
    /// choose but is right here: this streams, so the caller sees the output
    /// as it arrives and can stop the command by going away. A caller that
    /// cannot wait — an agent, which has no way to press Ctrl-C — says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub timeout_ms: Option<u64>,
}

/// What the operating system is holding a process to, told to whoever asked
/// for the process.
///
/// Without this a confined caller has to infer the rule from the symptoms, and
/// the symptoms differ by backend: a namespace makes the rest of the filesystem
/// *absent* (`ENOENT`), Landlock leaves it there and *refuses* it (`EACCES`).
/// An agent reading "no such file" concludes the directory does not exist and
/// sets about creating it. Saying the rule up front is cheaper than every
/// caller guessing it wrong differently.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct Confinement {
    pub backend: IsolationBackend,
    /// Absolute paths the process can reach and write. Everything outside them
    /// is absent or refused; which of the two depends on `backend`.
    pub roots: Vec<String>,
}

/// One message from a running command.
///
/// The two output streams stay apart the whole way. A terminal merges them
/// because a person is reading both at once; a caller that has to tell a
/// diagnostic from a result cannot un-merge them afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ShellFrame {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    /// Always the last frame, and sent even when the command was killed —
    /// a stream that simply stopped would be indistinguishable from a
    /// connection that broke.
    Exit {
        /// Absent when a signal ended the process, which is the one case where
        /// there is no exit status to report.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        code: Option<i32>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        signal: Option<i32>,
        /// Whether the command was ended because it ran out of time rather
        /// than because it finished.
        ///
        /// Not inferable from the rest: a command ended this way reports
        /// exactly what one killed for any other reason reports, and "killed
        /// by SIGKILL" would leave the caller to guess between "it hung" and
        /// "somebody stopped it". The difference decides whether retrying with
        /// a longer limit is sensible.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        timed_out: bool,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AssetPreviewKind {
    Image,
    Markdown,
    Text,
    Html,
    Video,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct AssetPreviewMetadata {
    pub kind: AssetPreviewKind,
    pub media_type: String,
    #[ts(type = "number")]
    pub source_bytes: u64,
    /// Stable enough to make a stale viewer response detectable without
    /// exposing an operating-system path.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum AssetPreviewError {
    NotFound,
    Forbidden,
    Unsupported,
    TooLarge,
    SourceChanged,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_source_has_exactly_one_mvp_kind() {
        let value = serde_json::to_value(AssetPreviewRequest {
            source: WorkspaceFileSource {
                kind: WorkspaceFileSourceKind::WorkspaceFile,
                workspace_handle: "w_one".into(),
                path: "docs/readme.md".into(),
            },
            diagnostic_id: None,
        })
        .unwrap();
        assert_eq!(value["source"]["kind"], "workspaceFile");
        assert_eq!(value["source"]["path"], "docs/readme.md");
    }

    #[test]
    fn the_wire_limits_stay_small_and_preview_stays_exact() {
        assert_eq!(MAX_DATA_FRAME_BYTES, 16_384);
        assert_eq!(MAX_FINITE_EXCHANGE_BODY_BYTES, 4_194_304);
        assert_eq!(MAX_PREVIEW_SOURCE_BYTES, 4_194_304);
    }
}
