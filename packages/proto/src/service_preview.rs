//! Versioned public subset for an explicitly registered service Preview.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewRoute {
    pub prefix: String,
    pub websocket: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewMedia {
    pub offer_path: String,
    pub stop_path: Option<String>,
    pub microphone: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewIceServer {
    pub urls: Vec<String>,
    pub username: Option<String>,
    pub credential: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewDescriptor {
    pub version: u32,
    pub run_id: String,
    pub name: String,
    pub routes: Vec<ServicePreviewRoute>,
    pub media: Option<ServicePreviewMedia>,
    pub ice_servers: Vec<ServicePreviewIceServer>,
    pub data_policy: String,
}
