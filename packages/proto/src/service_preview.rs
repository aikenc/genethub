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

impl ServicePreviewMedia {
    /// HTML media is additive to v1. Refuse an ambiguous/unknown mode before
    /// enabling a page; old descriptors with no client field keep their shape.
    pub fn validate_client(&self, routes: &[ServicePreviewRoute]) -> Result<(), &'static str> {
        let Some(client) = self.client.as_deref() else {
            return Ok(());
        };
        if client != "html" || self.protocol.as_deref() != Some("remote-desktop/1") {
            return Err("unsupported service media client or protocol");
        }
        let session = self
            .session_path
            .as_deref()
            .ok_or("missing media session path")?;
        let control = self
            .control_path
            .as_deref()
            .ok_or("missing media control path")?;
        let stop = self.stop_path.as_deref().ok_or("missing media stop path")?;
        let paths = [self.offer_path.as_str(), stop, session, control];
        for (i, path) in paths.iter().enumerate() {
            if !path.starts_with("/api/")
                || path.len() > 256
                || path.chars().any(|c| c.is_control() || "%\\?#".contains(c))
                || path.split('/').any(|s| s == "." || s == "..")
                || paths[..i].contains(path)
            {
                return Err("invalid or duplicate HTML media path");
            }
            let websocket = i >= 2;
            if !routes
                .iter()
                .any(|route| path.starts_with(&route.prefix) && (!websocket || route.websocket))
            {
                return Err("HTML media path is outside registered routes");
            }
        }
        if self
            .microphone
            .as_deref()
            .is_some_and(|mode| mode != "none")
        {
            return Err("HTML media does not support local microphone capture");
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewMedia {
    pub offer_path: String,
    pub stop_path: Option<String>,
    pub microphone: Option<String>,
    // Absent means the existing trusted Workbench media panel.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub client: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub protocol: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub session_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub control_path: Option<String>,
}

/// The small page API is scoped to the enabled entry, never a daemon Client.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "service-preview.ts")]
pub struct ServicePreviewPageState {
    pub descriptor: ServicePreviewDescriptor,
    pub control_allowed: bool,
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
