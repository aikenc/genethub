//! Provider configuration operations. Secret input travels only Human -> daemon.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct ProviderDraft {
    pub provider_id: String,
    pub label: String,
    pub base_url: String,
    pub dialect: String,
    #[serde(default)]
    pub models: Vec<String>,
    /// Capability values the Agent proposes per model. Shown to the Human
    /// before anything is written; once approved they count as user values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model_capabilities: Option<std::collections::BTreeMap<String, crate::ModelCapabilities>>,
}

#[derive(Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ProviderOperationCommand {
    #[serde(rename_all = "camelCase")]
    Prepare {
        action_id: String,
        draft: ProviderDraft,
    },
    #[serde(rename_all = "camelCase")]
    Get { action_id: String },
    #[serde(rename_all = "camelCase")]
    Submit {
        action_id: String,
        approved: bool,
        #[serde(default)]
        #[ts(optional)]
        api_key: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    Verify { action_id: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ProviderValidation {
    /// unverified | missingCredential | authenticationFailed | modelUnavailable |
    /// unreachable | invalidResponse | thinkingRejected | ready. `thinkingRejected`
    /// means a plain call worked but the thinking a session would send did not.
    /// No remote body/credential is returned.
    pub status: String,
    pub detail: String,
    #[ts(optional)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ProviderOperationReceipt {
    pub action_id: String,
    pub session_id: String,
    pub draft: ProviderDraft,
    /// pending | applying | saved | rejected | stale | unknown.
    pub state: String,
    pub key_required: bool,
    pub replaces_endpoint: bool,
    pub validation: ProviderValidation,
    #[ts(type = "number")]
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct CallerAuthority {
    pub principal_type: String,
    #[ts(optional)]
    pub session_id: Option<String>,
    pub grants: Vec<String>,
    pub provider_operations: bool,
    pub provider_request_command: String,
}

impl std::fmt::Debug for ProviderOperationCommand {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Prepare { action_id, draft } => f
                .debug_struct("Prepare")
                .field("action_id", action_id)
                .field("draft", draft)
                .finish(),
            Self::Get { action_id } => f.debug_struct("Get").field("action_id", action_id).finish(),
            Self::Verify { action_id } => f
                .debug_struct("Verify")
                .field("action_id", action_id)
                .finish(),
            Self::Submit {
                action_id,
                approved,
                api_key,
            } => f
                .debug_struct("Submit")
                .field("action_id", action_id)
                .field("approved", approved)
                .field("has_api_key", &api_key.is_some())
                .finish(),
        }
    }
}
