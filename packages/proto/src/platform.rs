//! Stable Platform control and release-discovery contracts.
//!
//! These messages are intentionally outside the product `Request`/`Reply`
//! enum. A Platform can check and activate a signed application even when the
//! currently active business protocol cannot understand the newest Web.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PATCH_CONTROL_METHOD: &str = "platform.patch";
pub const LOGIC_IDENTITY_METHOD: &str = "platform.logic.identity";
pub const LOGIC_MANIFEST_SCHEMA: &str = "genehub.logic-manifest.v1";
pub const APP_MANIFEST_SCHEMA: &str = "genehub.app-manifest.v1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
// ts-rs deliberately ignores serde's whole enum attribute when it encounters
// `deny_unknown_fields`. Repeat the wire-shape attributes here so generated
// clients describe the JSON serde actually emits.
#[ts(export, export_to = "index.ts", tag = "type", rename_all = "camelCase")]
pub enum PatchControlRequest {
    Check,
    #[serde(rename_all = "camelCase")]
    Apply {
        request_id: String,
        #[serde(default)]
        terminate_activities: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct LogicIdentity {
    pub channel: String,
    #[ts(type = "number")]
    pub logic_revision: u64,
    pub platform_abi: u32,
    pub protocol_version: u32,
    pub digest: String,
    pub origin: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct PatchArtifactSummary {
    #[ts(type = "number")]
    pub logic_revision: u64,
    pub platform_abi: u32,
    pub protocol_version: u32,
    pub digest: String,
    #[ts(type = "number")]
    pub size: u64,
    pub open_source_sha: String,
    pub cloud_source_sha: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct PatchBlockers {
    pub active_sessions: u32,
    pub terminals: u32,
    pub native_resources: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts", tag = "type", rename_all = "camelCase")]
pub enum PatchAvailability {
    Current,
    #[serde(rename_all = "camelCase")]
    Available {
        artifact: PatchArtifactSummary,
    },
    #[serde(rename_all = "camelCase")]
    RequiresApp {
        required_platform_abi: u32,
        app_manifest_urls: Vec<String>,
    },
    #[serde(rename_all = "camelCase")]
    Paused {
        reason: String,
    },
    Unconfigured,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts", tag = "type", rename_all = "camelCase")]
pub enum PatchControlResponse {
    #[serde(rename_all = "camelCase")]
    Status {
        active: LogicIdentity,
        #[ts(type = "number")]
        highest_accepted_revision: u64,
        availability: PatchAvailability,
    },
    #[serde(rename_all = "camelCase")]
    Busy {
        active: LogicIdentity,
        blockers: PatchBlockers,
    },
    #[serde(rename_all = "camelCase")]
    Applied {
        request_id: String,
        active: LogicIdentity,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct ArtifactSource {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct ArtifactDescriptor {
    pub sources: Vec<ArtifactSource>,
    pub sha256: String,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct SourceRevision {
    pub open_sha: String,
    pub cloud_sha: String,
    pub lockfile_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct LogicActivation {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub paused_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct LogicManifest {
    pub schema: String,
    pub channel: String,
    #[ts(type = "number")]
    pub logic_revision: u64,
    pub platform_abi: u32,
    pub protocol_version: u32,
    pub artifact: ArtifactDescriptor,
    pub source: SourceRevision,
    pub activation: LogicActivation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct AppInstaller {
    pub target: String,
    pub artifact: ArtifactDescriptor,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct BundledLogic {
    pub channel: String,
    #[ts(type = "number")]
    pub logic_revision: u64,
    pub platform_abi: u32,
    pub protocol_version: u32,
    pub component_sha256: String,
    pub key_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct AppManifest {
    pub schema: String,
    pub channel: String,
    pub release: String,
    pub platform_abi: u32,
    pub bundled_logic: BundledLogic,
    pub installers: Vec<AppInstaller>,
    pub source: SourceRevision,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_control_is_not_a_business_request() {
        let wire = serde_json::to_string(&PatchControlRequest::Apply {
            request_id: "ptc_123".into(),
            terminate_activities: true,
        })
        .unwrap();
        assert_eq!(
            wire,
            r#"{"type":"apply","requestId":"ptc_123","terminateActivities":true}"#
        );
        assert!(serde_json::from_str::<crate::Request>(&wire).is_err());
    }

    #[test]
    fn app_manifest_freezes_the_bundled_logic_identity() {
        let manifest = AppManifest {
            schema: APP_MANIFEST_SCHEMA.into(),
            channel: "beta".into(),
            release: "1.2.3-beta.4".into(),
            platform_abi: 19,
            bundled_logic: BundledLogic {
                channel: "beta".into(),
                logic_revision: 41,
                platform_abi: 19,
                protocol_version: 3,
                component_sha256: "a".repeat(64),
                key_id: "beta-2026".into(),
            },
            installers: Vec::new(),
            source: SourceRevision {
                open_sha: "b".repeat(40),
                cloud_sha: "c".repeat(40),
                lockfile_sha256: "d".repeat(64),
            },
        };

        let wire = serde_json::to_value(manifest).unwrap();
        assert_eq!(wire["bundledLogic"]["logicRevision"], 41);
        assert_eq!(wire["bundledLogic"]["componentSha256"], "a".repeat(64));
    }
}
