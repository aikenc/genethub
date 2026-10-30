//! remote-desktop/1 application messages carried by existing Service Preview.
//! This is not another Exchange or daemon authorization protocol.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const REMOTE_DESKTOP_PROTOCOL: &str = "remote-desktop/1";

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "remote-desktop.ts")]
pub struct RemoteDesktopTarget {
    pub id: String,
    pub name: String,
    pub generation: u32,
    pub width: u32,
    pub height: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "remote-desktop.ts")]
pub struct RemoteDesktopSession {
    pub session_id: String,
    pub session_token: String,
    pub target: RemoteDesktopTarget,
    pub ttl_ms: u32,
    pub protocol: String,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "remote-desktop.ts")]
pub struct RemoteDesktopLease {
    pub state: String,
    pub lease_id: String,
    pub epoch: u32,
    pub target_generation: u32,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "remote-desktop.ts")]
pub struct RemoteDesktopInput {
    pub session_id: String,
    pub epoch: u32,
    pub target_generation: u32,
    pub seq: u32,
    pub event: RemoteDesktopInputEvent,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "remote-desktop.ts")]
pub enum RemoteDesktopInputEvent {
    Key {
        code: String,
        down: bool,
    },
    Text {
        text: String,
    },
    Absolute {
        x: f64,
        y: f64,
    },
    Relative {
        #[serde(rename = "dxTotal")]
        dx_total: f64,
        #[serde(rename = "dyTotal")]
        dy_total: f64,
    },
    Button {
        button: u8,
        down: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        y: Option<f64>,
    },
    Wheel {
        dx: f64,
        dy: f64,
    },
    /// Reliable held-state progress; a live WS alone cannot keep keys pressed
    /// when the input DataChannel stops delivering.
    State {
        keys: Vec<String>,
        buttons: Vec<u8>,
    },
    Reset,
}
