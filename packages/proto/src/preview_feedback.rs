//! File-bound preview feedback, independent of an Agent Session.
use crate::{
    PreviewAnnotation, PreviewReviewDraft, SessionArtifactBundle, SessionArtifactFile,
    SessionArtifactUpload,
};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PreviewSourceInfo {
    pub machine_name: String,
    pub project_name: String,
    pub root_name: String,
    pub root_handle: String,
    pub path: String,
    pub relative_path: String,
    pub display_path: String,
    pub absolute_path: String,
    pub version: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PreviewFeedbackRequest {
    pub workspace_id: String,
    pub operation: PreviewFeedbackOperation,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "index.ts")]
pub enum PreviewFeedbackOperation {
    Source {
        path: String,
    },
    Share {
        path: String,
        ttl_seconds: u32,
        #[serde(default)]
        resources: Vec<String>,
    },
    Revoke {
        share_id: String,
    },
    Open {
        path: String,
        version: String,
        #[serde(default)]
        draft_id: Option<String>,
    },
    Draft {
        id: String,
    },
    Upsert {
        id: String,
        annotation: PreviewAnnotation,
        #[ts(type = "number")]
        expected_revision: u64,
    },
    Remove {
        id: String,
        ids: Vec<String>,
        #[ts(type = "number")]
        expected_revision: u64,
    },
    BeginArtifact {
        id: String,
        files: Vec<SessionArtifactFile>,
        metadata: serde_json::Value,
    },
    Chunk {
        id: String,
        upload_id: String,
        file_index: u32,
        #[ts(type = "number")]
        offset: u64,
        data_base64: String,
    },
    FinishArtifact {
        id: String,
        upload_id: String,
    },
    AbortArtifact {
        id: String,
        upload_id: String,
    },
    Submit {
        id: String,
        description: String,
        annotation_ids: Vec<String>,
        bundle_paths: Vec<String>,
    },
    Read {
        id: String,
    },
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PreviewShareLink {
    pub share_id: String,
    pub token: String,
    pub redeem_url: String,
    #[ts(type = "number")]
    pub expires_at_ms: i64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PreviewFeedbackDraft {
    pub id: String,
    pub source: PreviewSourceInfo,
    pub review: PreviewReviewDraft,
    pub bundles: Vec<SessionArtifactBundle>,
    pub receipt: Option<PreviewFeedbackRecord>,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct PreviewFeedbackRecord {
    pub id: String,
    pub source: PreviewSourceInfo,
    pub description: String,
    pub annotations: Vec<PreviewAnnotation>,
    pub bundles: Vec<SessionArtifactBundle>,
    #[ts(type = "number")]
    pub submitted_at_ms: i64,
    pub workspace_path: String,
    pub trust: String,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "data", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum PreviewFeedbackResponse {
    Source(PreviewSourceInfo),
    Share(PreviewShareLink),
    Draft(PreviewFeedbackDraft),
    Upload(SessionArtifactUpload),
    Artifact(SessionArtifactBundle),
    Receipt(PreviewFeedbackRecord),
    Ack,
}
