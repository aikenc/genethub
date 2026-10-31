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
        // `remote-desktop/1`: Capture's session, control and offer/stop routes.
        // `pixel-streaming/1`: an engine's own WebRTC signalling over one WebSocket
        // route; the page owns the peer and no separate control socket exists.
        let required: Vec<(&str, bool)> = match (client, self.protocol.as_deref()) {
            ("html", Some("remote-desktop/1")) => {
                let stop = self.stop_path.as_deref().ok_or("missing media stop path")?;
                let session = self
                    .session_path
                    .as_deref()
                    .ok_or("missing media session path")?;
                let control = self
                    .control_path
                    .as_deref()
                    .ok_or("missing media control path")?;
                vec![
                    (self.offer_path.as_str(), false),
                    (stop, false),
                    (session, true),
                    (control, true),
                ]
            }
            ("html", Some("pixel-streaming/1")) => {
                let session = self
                    .session_path
                    .as_deref()
                    .ok_or("missing media session path")?;
                vec![(session, true)]
            }
            _ => return Err("unsupported service media client or protocol"),
        };
        for (i, (path, websocket)) in required.iter().enumerate() {
            if !path.starts_with("/api/")
                || path.len() > 256
                || path.chars().any(|c| c.is_control() || "%\\?#".contains(c))
                || path.split('/').any(|s| s == "." || s == "..")
                || required[..i].iter().any(|(other, _)| other == path)
            {
                return Err("invalid or duplicate HTML media path");
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn route(prefix: &str, websocket: bool) -> ServicePreviewRoute {
        ServicePreviewRoute {
            prefix: prefix.into(),
            websocket,
        }
    }
    fn media(protocol: &str, session: &str) -> ServicePreviewMedia {
        ServicePreviewMedia {
            offer_path: session.into(),
            stop_path: None,
            microphone: Some("none".into()),
            client: Some("html".into()),
            protocol: Some(protocol.into()),
            session_path: Some(session.into()),
            control_path: None,
        }
    }

    #[test]
    fn pixel_streaming_needs_one_websocket_route_and_nothing_else() {
        let ws = [route("/api/ue/", true)];
        assert!(media("pixel-streaming/1", "/api/ue/ws")
            .validate_client(&ws)
            .is_ok());
        assert!(media("pixel-streaming/1", "/api/ue/ws")
            .validate_client(&[route("/api/ue/", false)])
            .is_err());
        assert!(media("pixel-streaming/1", "/api/other/ws")
            .validate_client(&ws)
            .is_err());
        assert!(media("pixel-streaming/1", "/api/ue/../ws")
            .validate_client(&ws)
            .is_err());
    }

    #[test]
    fn unknown_protocols_and_missing_remote_desktop_paths_are_refused() {
        let ws = [route("/api/ue/", true)];
        assert!(media("pixel-streaming/2", "/api/ue/ws")
            .validate_client(&ws)
            .is_err());
        // remote-desktop/1 still requires its stop and control paths.
        assert!(media("remote-desktop/1", "/api/ue/ws")
            .validate_client(&ws)
            .is_err());
        let mut plain = media("remote-desktop/1", "/api/ue/ws");
        plain.client = None;
        assert!(plain.validate_client(&ws).is_ok());
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
