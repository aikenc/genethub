use std::collections::BTreeMap;

use genehub_proto::{
    AgentInfo, Capabilities, Catalog, ModeInfo, ModelInfo, ProbeState, ProtocolError,
};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailureKind, CapabilityRequest, CapabilityValue,
    LogicBoot, ProcessRequest,
};
use serde::{Deserialize, Serialize};

use crate::config::Config;
use crate::CapabilityExecutor;

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Genet,
    OpenCode,
    Claude,
    Codex,
    Acp,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDefinition {
    pub id: String,
    pub label: String,
    pub kind: AgentKind,
    pub command: Vec<String>,
    pub builtin: bool,
}

impl AgentDefinition {
    pub fn program(&self) -> Option<&str> {
        self.command.first().map(String::as_str)
    }

    pub fn args(&self) -> &[String] {
        self.command.get(1..).unwrap_or_default()
    }

    pub fn capabilities(&self) -> Capabilities {
        match self.kind {
            AgentKind::Genet => Capabilities {
                interrupt: true,
                set_model: true,
                set_effort: true,
                set_mode: false,
                permissions: false,
                resume: true,
                fork: false,
                attachments: false,
            },
            AgentKind::OpenCode => Capabilities {
                interrupt: true,
                set_model: true,
                set_effort: true,
                set_mode: false,
                permissions: false,
                resume: true,
                fork: false,
                attachments: true,
            },
            AgentKind::Claude => Capabilities {
                interrupt: true,
                set_model: true,
                set_effort: true,
                set_mode: true,
                permissions: true,
                resume: true,
                fork: false,
                attachments: true,
            },
            AgentKind::Codex => Capabilities {
                interrupt: true,
                set_model: true,
                set_effort: true,
                set_mode: true,
                permissions: true,
                resume: true,
                fork: true,
                attachments: true,
            },
            AgentKind::Acp => Capabilities {
                interrupt: true,
                set_model: true,
                set_effort: false,
                set_mode: true,
                permissions: true,
                resume: true,
                fork: false,
                attachments: true,
            },
        }
    }

    pub fn catalog(&self, config: &Config) -> Catalog {
        match self.kind {
            AgentKind::Genet => genet_catalog(config),
            AgentKind::Claude => Catalog {
                modes: [
                    (
                        "acceptEdits",
                        "Accept edits",
                        "Apply file edits and commands without asking",
                    ),
                    (
                        "plan",
                        "Plan",
                        "Read and plan only — no edits and no commands",
                    ),
                    (
                        "bypassPermissions",
                        "Bypass permissions",
                        "Never ask about anything. Only for a trusted workspace",
                    ),
                ]
                .into_iter()
                .map(|(id, label, description)| ModeInfo {
                    id: id.to_string(),
                    label: label.to_string(),
                    description: Some(description.to_string()),
                })
                .collect(),
                default_mode: Some("bypassPermissions".to_string()),
                ..Catalog::default()
            },
            AgentKind::Codex => Catalog {
                modes: [
                    (
                        "read-only",
                        "Read only",
                        "Read and plan only; ask before changing anything",
                    ),
                    (
                        "auto",
                        "Default",
                        "Edit inside the workspace and ask before going beyond it",
                    ),
                    (
                        "full-access",
                        "Full access",
                        "Run without approval or filesystem restrictions",
                    ),
                ]
                .into_iter()
                .map(|(id, label, description)| ModeInfo {
                    id: id.to_string(),
                    label: label.to_string(),
                    description: Some(description.to_string()),
                })
                .collect(),
                default_mode: Some("full-access".to_string()),
                ..Catalog::default()
            },
            AgentKind::OpenCode | AgentKind::Acp => Catalog::default(),
        }
    }
}

pub fn definitions(boot: &LogicBoot, config: &Config) -> Vec<AgentDefinition> {
    let mut definitions = vec![
        AgentDefinition {
            id: "genet".to_string(),
            label: "GeneHub Agent".to_string(),
            kind: AgentKind::Genet,
            command: vec![boot
                .builtin_agent_binary
                .clone()
                .unwrap_or_else(|| "genet-agent".to_string())],
            builtin: true,
        },
        AgentDefinition {
            id: "opencode".to_string(),
            label: "OpenCode".to_string(),
            kind: AgentKind::OpenCode,
            command: vec!["opencode".to_string()],
            builtin: false,
        },
        AgentDefinition {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            kind: AgentKind::Claude,
            command: vec!["claude".to_string()],
            builtin: false,
        },
        AgentDefinition {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            kind: AgentKind::Codex,
            command: vec!["codex".to_string()],
            builtin: false,
        },
        AgentDefinition {
            id: "cursor".to_string(),
            label: "Cursor".to_string(),
            kind: AgentKind::Acp,
            command: [
                "cursor-agent",
                "--force",
                "--sandbox",
                "disabled",
                "--trust",
                "--approve-mcps",
                "acp",
            ]
            .into_iter()
            .map(str::to_string)
            .collect(),
            builtin: false,
        },
        AgentDefinition {
            id: "acp".to_string(),
            label: "ACP agent".to_string(),
            kind: AgentKind::Acp,
            command: vec!["acp-agent".to_string()],
            builtin: false,
        },
    ];
    definitions.extend(config.agents.custom.iter().filter_map(|(id, custom)| {
        if custom.extends != "acp" || custom.command.is_empty() {
            return None;
        }
        Some(AgentDefinition {
            id: format!("acp:{id}"),
            label: custom.label.clone().unwrap_or_else(|| id.clone()),
            kind: AgentKind::Acp,
            command: custom.command.clone(),
            builtin: false,
        })
    }));
    definitions
}

pub fn require(
    boot: &LogicBoot,
    config: &Config,
    id: &str,
) -> Result<AgentDefinition, ProtocolError> {
    definitions(boot, config)
        .into_iter()
        .find(|definition| definition.id == id)
        .ok_or_else(|| ProtocolError {
            code: genehub_proto::ErrorCode::NotFound,
            message: format!("no such agent: {id}"),
        })
}

pub fn list(
    boot: &LogicBoot,
    config: &Config,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<AgentInfo>, ProtocolError> {
    let definitions = definitions(boot, config);
    let batch_id = take_id(next);
    let mut calls = Vec::with_capacity(definitions.len());
    let mut call_ids = BTreeMap::new();
    for definition in &definitions {
        let call_id = take_id(next);
        call_ids.insert(definition.id.clone(), call_id);
        calls.push(CapabilityCall {
            call_id,
            request: CapabilityRequest::Process(ProcessRequest::ResolveProgram {
                program: definition.program().unwrap_or_default().to_string(),
            }),
        });
    }
    let results = executor
        .execute(CapabilityBatch { batch_id, calls })
        .map_err(internal)?;
    let mut infos = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let call_id = call_ids[&definition.id];
        let result = results
            .results
            .iter()
            .find(|result| result.call_id == call_id);
        let probe = match result.map(|result| &result.result) {
            Some(Ok(CapabilityValue::Text(_))) => ProbeState::Ready,
            Some(Err(error)) if error.kind == CapabilityFailureKind::NotFound => {
                ProbeState::NotInstalled
            }
            Some(Err(error)) => ProbeState::Unavailable {
                reason: error.message.clone(),
            },
            Some(Ok(_)) | None => ProbeState::Unavailable {
                reason: "executable resolver returned a malformed result".to_string(),
            },
        };
        infos.push(AgentInfo {
            id: definition.id.clone(),
            label: definition.label.clone(),
            probe,
            capabilities: definition.capabilities(),
            catalog: definition.catalog(config),
            builtin: definition.builtin,
        });
    }
    Ok(infos)
}

fn genet_catalog(config: &Config) -> Catalog {
    let mut models = Vec::new();
    for (provider_id, provider) in &config.agents.providers {
        if provider
            .api_key
            .as_deref()
            .is_none_or(|value| value.is_empty())
        {
            continue;
        }
        let label = provider
            .label
            .clone()
            .unwrap_or_else(|| provider_id.clone());
        for model in &provider.models {
            models.push(ModelInfo {
                id: format!("{provider_id}/{model}"),
                label: format!("{label}:{model}"),
                context_window: None,
                reasoning: model.to_ascii_lowercase().contains("reason"),
                efforts: THINKING_LEVELS
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
            });
        }
    }
    Catalog {
        default_model: models.first().map(|model| model.id.clone()),
        default_effort: Some("medium".to_string()),
        models,
        ..Catalog::default()
    }
}

fn take_id(next: &mut u64) -> u64 {
    let id = *next;
    *next = next.saturating_add(1);
    id
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: genehub_proto::ErrorCode::Internal,
        message: message.into(),
    }
}
