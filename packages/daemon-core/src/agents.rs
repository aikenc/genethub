use std::collections::BTreeMap;

use genehub_proto::{
    AgentInfo, Capabilities, Catalog, ModeInfo, ModelInfo, ProbeState, ProtocolError,
};
use genet_daemon_logic_api::{
    CapabilityBatch, CapabilityCall, CapabilityFailureKind, CapabilityRequest, CapabilityResults,
    CapabilityValue, ConfinementMode, FileLocator, FileRequest, FileRoot, LogicBoot,
    ProcessDialogueStep, ProcessRequest, ProcessSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::config::Config;
use crate::session::{acp, claude, codex};
use crate::CapabilityExecutor;

const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const DISCOVERY_STDOUT_BYTES: u32 = 2 * 1024 * 1024;
const DISCOVERY_STDERR_BYTES: u32 = 512 * 1024;
const DISCOVERY_TIMEOUT_MILLIS: u32 = 45_000;

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
    #[serde(default)]
    pub home_env: Option<String>,
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
                // Bypass is the one launch mode GeneHub itself requires and
                // supports across Claude versions. Every other mode is offered
                // only after this installed CLI names it in `--help`; inventing
                // a static choice makes the picker claim a mode exists when an
                // older or vendor-patched build may reject it.
                modes: [(
                    "bypassPermissions",
                    "Bypass permissions",
                    "Never ask about anything. Only for a trusted workspace",
                )]
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
            home_env: boot.builtin_agent_home_env.clone(),
        },
        AgentDefinition {
            id: "opencode".to_string(),
            label: "OpenCode".to_string(),
            kind: AgentKind::OpenCode,
            command: vec!["opencode".to_string()],
            builtin: false,
            home_env: None,
        },
        AgentDefinition {
            id: "claude".to_string(),
            label: "Claude Code".to_string(),
            kind: AgentKind::Claude,
            command: vec!["claude".to_string()],
            builtin: false,
            home_env: None,
        },
        AgentDefinition {
            id: "codex".to_string(),
            label: "Codex".to_string(),
            kind: AgentKind::Codex,
            command: vec!["codex".to_string()],
            builtin: false,
            home_env: None,
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
            home_env: None,
        },
        AgentDefinition {
            id: "acp".to_string(),
            label: "ACP agent".to_string(),
            kind: AgentKind::Acp,
            command: vec!["acp-agent".to_string()],
            builtin: false,
            home_env: None,
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
            home_env: None,
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
    let private_path_call = take_id(next);
    let mut calls = Vec::with_capacity(definitions.len() + 1);
    let mut call_ids = BTreeMap::new();
    calls.push(CapabilityCall {
        call_id: private_path_call,
        request: CapabilityRequest::File(FileRequest::Metadata {
            locator: discovery_cwd(),
        }),
    });
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
    let private_path = capability_result(&results, private_path_call)
        .and_then(|result| result.as_ref().ok())
        .and_then(|value| match value {
            CapabilityValue::FileMetadata(metadata) => metadata.canonical_path.clone(),
            _ => None,
        })
        .or_else(|| boot.home_directory.clone())
        .unwrap_or_else(|| ".".to_string());
    let mut entries = Vec::with_capacity(definitions.len());
    for definition in definitions {
        let call_id = call_ids[&definition.id];
        let result = capability_result(&results, call_id);
        let (probe, program) = match result {
            Some(Ok(CapabilityValue::Text(program))) => (ProbeState::Ready, Some(program.clone())),
            Some(Err(error)) if error.kind == CapabilityFailureKind::NotFound => {
                (ProbeState::NotInstalled, None)
            }
            Some(Err(error)) => (
                ProbeState::Unavailable {
                    reason: error.message.clone(),
                },
                None,
            ),
            Some(Ok(_)) | None => (
                ProbeState::Unavailable {
                    reason: "executable resolver returned a malformed result".to_string(),
                },
                None,
            ),
        };
        entries.push((definition, probe, program));
    }

    // Capability calls in one batch are independent. Keeping every optional
    // CLI handshake in one batch lets the native driver wait for the slowest
    // probe instead of summing all cold-start timeouts.
    let discovery_batch = take_id(next);
    let mut discovery_calls = Vec::new();
    let mut discovery_ids = BTreeMap::<String, DiscoveryCalls>::new();
    for (definition, probe, program) in &entries {
        if !matches!(probe, ProbeState::Ready) {
            continue;
        }
        let Some(program) = program else { continue };
        let ids = discovery_ids.entry(definition.id.clone()).or_default();
        match definition.kind {
            AgentKind::Claude => {
                ids.help = Some(push_call(
                    next,
                    &mut discovery_calls,
                    run_request(
                        process_spec(program, extended_args(definition.args(), ["--help"])),
                        Vec::new(),
                        15_000,
                    ),
                ));
                ids.catalog = Some(push_call(
                    next,
                    &mut discovery_calls,
                    claude_discovery(program, definition.args())?,
                ));
            }
            AgentKind::Codex => {
                ids.login = Some(push_call(
                    next,
                    &mut discovery_calls,
                    run_request(
                        process_spec(
                            program,
                            extended_args(definition.args(), ["login", "status"]),
                        ),
                        Vec::new(),
                        15_000,
                    ),
                ));
                ids.catalog = Some(push_call(
                    next,
                    &mut discovery_calls,
                    codex_discovery(program, definition.args())?,
                ));
            }
            AgentKind::Acp => {
                ids.catalog = Some(push_call(
                    next,
                    &mut discovery_calls,
                    acp_discovery(program, definition.args(), &private_path)?,
                ));
            }
            AgentKind::Genet | AgentKind::OpenCode => {}
        }
    }
    let discovered = if discovery_calls.is_empty() {
        None
    } else {
        Some(
            executor
                .execute(CapabilityBatch {
                    batch_id: discovery_batch,
                    calls: discovery_calls,
                })
                .map_err(internal)?,
        )
    };

    let mut infos = Vec::with_capacity(entries.len());
    for (definition, mut probe, _) in entries {
        let fallback = definition.catalog(config);
        let ids = discovery_ids
            .get(&definition.id)
            .cloned()
            .unwrap_or_default();
        let catalog = match definition.kind {
            AgentKind::Claude => {
                let help = discovered
                    .as_ref()
                    .and_then(|results| process_output(results, ids.help))
                    .map(joined_output)
                    .unwrap_or_default();
                let hello = discovered
                    .as_ref()
                    .and_then(|results| process_output(results, ids.catalog))
                    .and_then(|output| claude_hello(&output.0));
                let mut catalog = claude::catalog(&help, hello.as_ref());
                if help.is_empty() {
                    catalog.modes = fallback.modes;
                    catalog.default_mode = fallback.default_mode;
                }
                catalog
            }
            AgentKind::Codex => {
                if let Some((stdout, stderr, _)) = discovered
                    .as_ref()
                    .and_then(|results| process_output(results, ids.login))
                {
                    if codex::login_probe(&stdout, &stderr) {
                        probe = ProbeState::Unavailable {
                            reason: "找到了 Codex，但它还没登录：先跑 codex login（或者 printenv OPENAI_API_KEY | codex login --with-api-key）".to_string(),
                        };
                    }
                }
                let listed = discovered
                    .as_ref()
                    .and_then(|results| process_output(results, ids.catalog))
                    .and_then(|output| rpc_result(&output.0, 2));
                codex::catalog(listed.as_ref())
            }
            AgentKind::Acp => {
                let created = discovered
                    .as_ref()
                    .and_then(|results| process_output(results, ids.catalog))
                    .and_then(|output| rpc_result(&output.0, 2));
                acp::catalog(created.as_ref())
            }
            AgentKind::Genet | AgentKind::OpenCode => fallback,
        };
        infos.push(AgentInfo {
            id: definition.id.clone(),
            label: definition.label.clone(),
            probe,
            capabilities: definition.capabilities(),
            catalog,
            builtin: definition.builtin,
        });
    }
    Ok(infos)
}

#[derive(Clone, Default)]
struct DiscoveryCalls {
    help: Option<u64>,
    login: Option<u64>,
    catalog: Option<u64>,
}

fn capability_result(
    results: &CapabilityResults,
    call_id: u64,
) -> Option<&Result<CapabilityValue, genet_daemon_logic_api::CapabilityFailure>> {
    results
        .results
        .iter()
        .find(|result| result.call_id == call_id)
        .map(|result| &result.result)
}

fn discovery_cwd() -> FileLocator {
    FileLocator {
        root: FileRoot::Private,
        path: String::new(),
    }
}

fn process_spec(program: &str, args: Vec<String>) -> ProcessSpec {
    ProcessSpec {
        program: program.to_string(),
        args,
        env: BTreeMap::new(),
        cwd: Some(discovery_cwd()),
        confinement: ConfinementMode::None,
        capture_stdout: true,
        capture_stderr: true,
    }
}

fn extended_args<const N: usize>(base: &[String], extra: [&str; N]) -> Vec<String> {
    base.iter()
        .cloned()
        .chain(extra.into_iter().map(str::to_string))
        .collect()
}

fn run_request(spec: ProcessSpec, stdin: Vec<u8>, timeout_millis: u32) -> CapabilityRequest {
    CapabilityRequest::Process(ProcessRequest::Run {
        spec,
        stdin,
        timeout_millis,
        max_stdout_bytes: DISCOVERY_STDOUT_BYTES,
        max_stderr_bytes: DISCOVERY_STDERR_BYTES,
    })
}

fn dialogue_request(spec: ProcessSpec, steps: Vec<ProcessDialogueStep>) -> CapabilityRequest {
    CapabilityRequest::Process(ProcessRequest::Dialogue {
        spec,
        steps,
        timeout_millis: DISCOVERY_TIMEOUT_MILLIS,
        max_stdout_bytes: DISCOVERY_STDOUT_BYTES,
        max_stderr_bytes: DISCOVERY_STDERR_BYTES,
    })
}

fn claude_discovery(program: &str, base: &[String]) -> Result<CapabilityRequest, ProtocolError> {
    let args = extended_args(
        base,
        [
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--allow-dangerously-skip-permissions",
            "--settings",
            r#"{"sandbox":{"enabled":false}}"#,
        ],
    );
    Ok(dialogue_request(
        process_spec(program, args),
        vec![dialogue_step(
            json!({
                "type": "control_request",
                "request_id": "genehub_initialize",
                "request": { "subtype": "initialize" }
            }),
            b"genehub_initialize",
        )?],
    ))
}

fn codex_discovery(program: &str, base: &[String]) -> Result<CapabilityRequest, ProtocolError> {
    let args = extended_args(
        base,
        [
            "app-server",
            "-c",
            "approval_policy=\"never\"",
            "-c",
            "sandbox_mode=\"danger-full-access\"",
        ],
    );
    Ok(dialogue_request(
        process_spec(program, args),
        vec![
            dialogue_step(
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "initialize",
                    "params": { "clientInfo": {
                        "name": "codex_app_server_daemon",
                        "title": "GeneHub",
                        "version": env!("CARGO_PKG_VERSION"),
                    }}
                }),
                b"\"id\":1",
            )?,
            dialogue_frames(
                &[
                    json!({ "jsonrpc":"2.0", "method":"initialized", "params":{} }),
                    json!({ "jsonrpc":"2.0", "id":2, "method":"model/list", "params":{} }),
                ],
                b"\"id\":2",
            )?,
        ],
    ))
}

fn acp_discovery(
    program: &str,
    base: &[String],
    cwd: &str,
) -> Result<CapabilityRequest, ProtocolError> {
    Ok(dialogue_request(
        process_spec(program, base.to_vec()),
        vec![
            dialogue_step(
                json!({
                    "jsonrpc":"2.0",
                    "id":1,
                    "method":"initialize",
                    "params":{
                        "protocolVersion":1,
                        "clientCapabilities":{
                            "fs":{"readTextFile":false,"writeTextFile":false},
                            "session":{"configOptions":{"boolean":{}}}
                        }
                    }
                }),
                b"\"id\":1",
            )?,
            dialogue_step(
                json!({
                    "jsonrpc":"2.0",
                    "id":2,
                    "method":"session/new",
                    "params":{"cwd":cwd,"mcpServers":[]}
                }),
                b"\"id\":2",
            )?,
        ],
    ))
}

fn dialogue_step(value: Value, marker: &[u8]) -> Result<ProcessDialogueStep, ProtocolError> {
    dialogue_frames(&[value], marker)
}

fn dialogue_frames(values: &[Value], marker: &[u8]) -> Result<ProcessDialogueStep, ProtocolError> {
    let mut stdin = Vec::new();
    for value in values {
        serde_json::to_writer(&mut stdin, value)
            .map_err(|error| internal(format!("encoding Agent discovery request: {error}")))?;
        stdin.push(b'\n');
    }
    Ok(ProcessDialogueStep {
        stdin,
        wait_for_line: marker.to_vec(),
    })
}

fn push_call(next: &mut u64, calls: &mut Vec<CapabilityCall>, request: CapabilityRequest) -> u64 {
    let call_id = take_id(next);
    calls.push(CapabilityCall { call_id, request });
    call_id
}

fn process_output(
    results: &CapabilityResults,
    call_id: Option<u64>,
) -> Option<(Vec<u8>, Vec<u8>, Option<i32>)> {
    match capability_result(results, call_id?)? {
        Ok(CapabilityValue::ProcessCompleted {
            stdout,
            stderr,
            code,
        }) => Some((stdout.clone(), stderr.clone(), *code)),
        _ => None,
    }
}

fn joined_output((stdout, stderr, _): (Vec<u8>, Vec<u8>, Option<i32>)) -> String {
    let mut output = String::from_utf8_lossy(&stdout).to_string();
    output.push_str(&String::from_utf8_lossy(&stderr));
    output
}

fn frames(bytes: &[u8]) -> impl Iterator<Item = Value> + '_ {
    bytes
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice(line).ok())
}

fn rpc_result(bytes: &[u8], id: i64) -> Option<Value> {
    frames(bytes)
        .find(|frame| frame.get("id").and_then(Value::as_i64) == Some(id))?
        .get("result")
        .cloned()
}

fn claude_hello(bytes: &[u8]) -> Option<Value> {
    let response = frames(bytes).find(|frame| {
        frame.get("type").and_then(Value::as_str) == Some("control_response")
            && frame
                .get("response")
                .and_then(|response| response.get("request_id"))
                .and_then(Value::as_str)
                == Some("genehub_initialize")
    })?;
    let response = response.get("response")?;
    (response.get("subtype").and_then(Value::as_str) == Some("success"))
        .then(|| response.get("response").cloned())
        .flatten()
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
        let label = crate::config::resolve(provider_id, provider).label;
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

#[cfg(test)]
mod tests {
    use super::*;
    use genet_daemon_logic_api::{CapabilityFailure, CapabilityResult, FileKind, FileMetadata};

    #[derive(Default)]
    struct DiscoveryExecutor {
        batches: Vec<Vec<CapabilityRequest>>,
    }

    impl CapabilityExecutor for DiscoveryExecutor {
        fn execute(&mut self, batch: CapabilityBatch) -> Result<CapabilityResults, String> {
            self.batches.push(
                batch
                    .calls
                    .iter()
                    .map(|call| call.request.clone())
                    .collect(),
            );
            let results = batch
                .calls
                .into_iter()
                .map(|call| CapabilityResult {
                    call_id: call.call_id,
                    result: answer(call.request),
                })
                .collect();
            Ok(CapabilityResults {
                batch_id: batch.batch_id,
                results,
            })
        }
    }

    fn answer(request: CapabilityRequest) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            CapabilityRequest::File(FileRequest::Metadata { .. }) => {
                Ok(CapabilityValue::FileMetadata(FileMetadata {
                    kind: FileKind::Directory,
                    bytes: 0,
                    modified_at_millis: None,
                    canonical_path: Some("/private/discovery".to_string()),
                    parent_path: None,
                    file_name: None,
                    extension: None,
                }))
            }
            CapabilityRequest::Process(ProcessRequest::ResolveProgram { program }) => {
                Ok(CapabilityValue::Text(format!("/tools/{program}")))
            }
            CapabilityRequest::Process(ProcessRequest::Run { spec, .. })
                if spec.args.iter().any(|arg| arg == "--help") =>
            {
                Ok(completed(
                    br#"--permission-mode choices: default, acceptEdits, plan, bypassPermissions"#,
                    b"",
                ))
            }
            CapabilityRequest::Process(ProcessRequest::Run { spec, .. })
                if spec.args.windows(2).any(|args| args == ["login", "status"]) =>
            {
                Ok(completed(b"", b"Not logged in. Run codex login"))
            }
            CapabilityRequest::Process(ProcessRequest::Dialogue { spec, steps, .. })
                if spec.args.iter().any(|arg| arg == "app-server") =>
            {
                assert_eq!(steps.len(), 2);
                assert!(String::from_utf8_lossy(&steps[1].stdin).contains("model/list"));
                Ok(completed(
                    br#"{"jsonrpc":"2.0","id":1,"result":{}}
{"jsonrpc":"2.0","id":2,"result":{"data":[{"id":"gpt-5","displayName":"GPT-5","isDefault":true,"defaultReasoningEffort":"high","supportedReasoningEfforts":["low","high"]}]}}
"#,
                    b"",
                ))
            }
            CapabilityRequest::Process(ProcessRequest::Dialogue { spec, .. })
                if spec.program.ends_with("claude") =>
            {
                Ok(completed(
                    br#"{"type":"control_response","response":{"request_id":"genehub_initialize","subtype":"success","response":{"model":"sonnet","models":[{"value":"sonnet","displayName":"Sonnet","supportsEffort":true,"supportedEffortLevels":["low","high"]}],"commands":[{"name":"review","description":"Review changes"}]}}}
"#,
                    b"",
                ))
            }
            CapabilityRequest::Process(ProcessRequest::Dialogue { steps, .. }) => {
                assert!(String::from_utf8_lossy(&steps[1].stdin).contains("/private/discovery"));
                Ok(completed(
                    br#"{"jsonrpc":"2.0","id":1,"result":{"agentCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"result":{"sessionId":"probe","models":{"currentModelId":"composer","availableModels":[{"modelId":"composer","name":"Composer"}]},"modes":{"currentModeId":"agent","availableModes":[{"id":"agent","name":"Agent"}]}}}
"#,
                    b"",
                ))
            }
            other => panic!("unexpected discovery capability: {other:?}"),
        }
    }

    fn completed(stdout: &[u8], stderr: &[u8]) -> CapabilityValue {
        CapabilityValue::ProcessCompleted {
            code: Some(0),
            stdout: stdout.to_vec(),
            stderr: stderr.to_vec(),
        }
    }

    fn boot() -> LogicBoot {
        LogicBoot {
            daemon_version: "test".to_string(),
            protocol_version: 1,
            machine_id: "machine".to_string(),
            fingerprint: "fingerprint".to_string(),
            machine_name: "machine".to_string(),
            rtc_supported: false,
            features: Vec::new(),
            isolation: None,
            log_directory: "/logs".to_string(),
            log_display_directory: "/logs".to_string(),
            default_workspace: None,
            home_directory: Some("/home/test".to_string()),
            builtin_agent_binary: Some("genet-agent".to_string()),
            builtin_agent_home_env: Some("GENET_AGENT_HOME".to_string()),
        }
    }

    #[test]
    fn one_batched_guest_owned_discovery_restores_dynamic_catalogs_and_login_state() {
        let mut executor = DiscoveryExecutor::default();
        let agents = list(&boot(), &Config::default(), &mut executor, &mut 1).unwrap();

        assert_eq!(executor.batches.len(), 2);
        assert_eq!(executor.batches[0].len(), 7); // private cwd + six executables
        assert_eq!(executor.batches[1].len(), 6); // Claude 2 + Codex 2 + two ACPs

        let claude = agents.iter().find(|agent| agent.id == "claude").unwrap();
        assert_eq!(claude.catalog.default_model.as_deref(), Some("sonnet"));
        assert_eq!(claude.catalog.models[0].efforts, ["low", "high"]);
        assert_eq!(claude.catalog.commands[0].name, "review");
        assert!(claude.catalog.modes.iter().any(|mode| mode.id == "default"));

        let codex = agents.iter().find(|agent| agent.id == "codex").unwrap();
        assert!(matches!(codex.probe, ProbeState::Unavailable { .. }));
        assert_eq!(codex.catalog.default_model.as_deref(), Some("gpt-5"));
        assert_eq!(codex.catalog.default_effort.as_deref(), Some("high"));

        for id in ["cursor", "acp"] {
            let agent = agents.iter().find(|agent| agent.id == id).unwrap();
            assert_eq!(agent.catalog.default_model.as_deref(), Some("composer"));
            assert_eq!(agent.catalog.default_mode.as_deref(), Some("agent"));
        }
    }
}
