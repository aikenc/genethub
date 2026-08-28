use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSpaceRole {
    #[default]
    Implementation,
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpaceRecord {
    pub name: String,
    pub purpose: String,
    pub source_path: PathBuf,
    pub workspace_id: String,
    pub source_commit: String,
    pub builder_lock_digest: String,
    #[serde(default)]
    pub role: AgentSpaceRole,
    pub active: bool,
    pub updated_at_ms: i64,
}
