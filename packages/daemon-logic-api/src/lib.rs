//! Stable application messages crossing the daemon platform/Wasm boundary.
//!
//! The ABI itself moves one bounded byte buffer in and one bounded byte buffer
//! out per event. These types describe those buffers; individual strings never
//! become host calls, which keeps the native platform independent of business
//! schemas and avoids chatty FFI.

use genehub_proto::{ProtocolError, Reply, Request, TransportKind};
use serde::{Deserialize, Serialize};

/// Core-Wasm export contract implemented by `genet-daemon-logic`.
pub const ABI_VERSION: u32 = 2;
pub const SNAPSHOT_FORMAT_VERSION: u32 = 1;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicBoot {
    pub daemon_version: String,
    pub protocol_version: u32,
    pub machine_id: String,
    pub fingerprint: String,
    pub machine_name: String,
    pub rtc_supported: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LogicRequest {
    pub transport: TransportKind,
    pub request: Request,
}

/// Result of the portable policy/router stage.
///
/// `ContinueNative` is a migration valve, not a second wire protocol: the
/// already-decoded request stays in the caller and is never copied back across
/// the boundary. As business slices move into the Wasm app this variant shrinks
/// until only raw system capabilities remain native.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
pub enum LogicOutcome {
    ContinueNative,
    Reply(Box<Reply>),
    Error(ProtocolError),
}
