//! Opt-in client debugging over the existing encrypted machine data plane.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ClientDebugRequest {
    Register {
        label: String,
        url: String,
        user_agent: String,
    },
    List,
    Poll {
        client_id: String,
        owner: String,
    },
    Decide {
        client_id: String,
        owner: String,
        session: String,
        seconds: u32,
    },
    Complete {
        client_id: String,
        owner: String,
        command_id: String,
        result: serde_json::Value,
    },
    Attach {
        client_id: String,
        label: String,
    },
    Status {
        client_id: String,
        session: String,
    },
    Execute {
        client_id: String,
        session: String,
        action: ClientDebugAction,
    },
    Result {
        client_id: String,
        session: String,
        command_id: String,
    },
    Revoke {
        client_id: String,
        key: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export, export_to = "index.ts")]
pub enum ClientDebugAction {
    Inspect,
    Eval {
        script: String,
    },
    Screenshot,
    Act {
        selector: String,
        value: Option<String>,
    },
    Events,
    Reload,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ClientDebugResponse {
    pub value: ClientDebugValue,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged, rename_all_fields = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub enum ClientDebugValue {
    Registered {
        client_id: String,
        owner: String,
    },
    Clients(Vec<ClientDebugInfo>),
    Poll(ClientDebugPoll),
    Attached {
        session: String,
        status: String,
        authorization_timeout_seconds: u32,
    },
    Queued {
        command_id: String,
    },
    Completed {
        status: String,
        result: serde_json::Value,
    },
    Status {
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional, type = "number")]
        remaining_ms: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        seconds: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ClientDebugInfo {
    pub client_id: String,
    pub label: String,
    pub url: String,
    pub user_agent: String,
    pub authorized: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "index.ts")]
pub struct ClientDebugPoll {
    pub grant: Option<ClientDebugGrant>,
    pub command: Option<ClientDebugCommand>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ClientDebugGrant {
    pub session: String,
    pub label: String,
    pub approved: bool,
    #[ts(type = "number")]
    pub remaining_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "index.ts")]
pub struct ClientDebugCommand {
    pub command_id: String,
    pub action: ClientDebugAction,
}
