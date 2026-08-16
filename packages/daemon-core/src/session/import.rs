//! Provider-owned history discovery and import.
//!
//! Provider protocols, duplicate policy, expiry and transcript translation
//! belong to the signed guest. Native code only exposes bounded files and
//! byte-stream processes, so the same Linux-built artifact runs unchanged on
//! every supported host.

use std::collections::{BTreeMap, HashSet};

use genehub_proto::{
    HistoryCoverage, ImportContinuation, RetrievalCapability, SessionImportCandidate,
    SessionImportListing, SessionImportSource, SessionStatus, TimelineItem,
};
use genet_daemon_logic_api::{
    CapabilityFailureKind, CapabilityRequest, CapabilityValue, FileKind, FileLocator, FileRequest,
    FileRoot, LogicBoot, ProcessDialogueStep, ProcessRequest, ProcessSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::*;

const IMPORT_CANDIDATE_TTL_MS: i64 = 10 * 60 * 1000;
const PROVIDER_TIMEOUT_MS: u32 = 90_000;
const IMPORT_OUTPUT_BYTES: u32 = 3 * 1024 * 1024;
const NATIVE_HISTORY_MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CachedImportCandidate {
    workspace_id: String,
    cwd: String,
    agent_id: String,
    source_id: String,
    source_key: String,
    title: String,
    continuation: ImportContinuation,
    expires_at_ms: i64,
    #[serde(default)]
    method: Option<String>,
}

#[derive(Clone, Debug)]
struct Candidate {
    source_id: String,
    title: String,
    preview: String,
    updated_at_ms: i64,
    continuation: ImportContinuation,
    method: Option<String>,
}

struct ImportedHistory {
    title: Option<String>,
    created_at_ms: i64,
    updated_at_ms: i64,
    items: Vec<TimelineItem>,
    persist: Option<PersistHandle>,
    continuation: ImportContinuation,
    warnings: Vec<String>,
}

impl Sessions {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn list_imports(
        &mut self,
        workspace_id: &str,
        limit: Option<u32>,
        boot: &LogicBoot,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<SessionImportListing, ProtocolError> {
        let workspace = workspace(config, workspace_id)?;
        let folder = workspace
            .folders
            .first()
            .ok_or_else(|| bad_request("workspace has no folders"))?;
        let cwd = folder.root.clone();
        let cwd_locator = FileLocator {
            root: FileRoot::Workspace {
                handle: folder.root_handle.clone(),
            },
            path: String::new(),
        };
        let limit = limit.unwrap_or(20).clamp(1, 100) as usize;
        let timestamp = now(executor, next)?;
        let expires_at_ms = timestamp.saturating_add(IMPORT_CANDIDATE_TTL_MS);
        self.load_catalog(config, executor, next)?;
        let duplicate_keys = self
            .loaded
            .values()
            .filter(|live| live.meta.workspace_id == workspace_id)
            .filter_map(|live| {
                live.meta
                    .imported
                    .as_ref()
                    .map(|value| value.source_key.clone())
            })
            .collect::<HashSet<_>>();
        self.import_candidates.retain(|_, candidate| {
            candidate.expires_at_ms > timestamp && candidate.workspace_id != workspace_id
        });

        let mut filtered_duplicates = 0u32;
        let mut sources = Vec::new();
        for definition in agents::definitions(boot, config) {
            let discovered = discover(&definition, &cwd, &cwd_locator, limit, boot, executor, next);
            match discovered {
                Ok(Some(candidates)) => {
                    let mut public = Vec::new();
                    for candidate in candidates {
                        let source_key =
                            import_source_key(&definition.id, &cwd, &candidate.source_id);
                        if duplicate_keys.contains(&source_key) {
                            filtered_duplicates = filtered_duplicates.saturating_add(1);
                            continue;
                        }
                        let (random, _) = identity_and_time(executor, next)?;
                        let candidate_id = format!("ic_{}", random.trim_start_matches("s_"));
                        self.import_candidates.insert(
                            candidate_id.clone(),
                            CachedImportCandidate {
                                workspace_id: workspace_id.to_string(),
                                cwd: cwd.clone(),
                                agent_id: definition.id.clone(),
                                source_id: candidate.source_id,
                                source_key,
                                title: candidate.title.clone(),
                                continuation: candidate.continuation,
                                expires_at_ms,
                                method: candidate.method,
                            },
                        );
                        public.push(SessionImportCandidate {
                            candidate_id,
                            agent_id: definition.id.clone(),
                            title: candidate.title,
                            preview: candidate.preview,
                            updated_at_ms: candidate.updated_at_ms,
                            continuation: candidate.continuation,
                        });
                    }
                    sources.push(SessionImportSource {
                        agent_id: definition.id,
                        label: definition.label,
                        supported: true,
                        candidates: public,
                        error: None,
                    });
                }
                Ok(None) => sources.push(SessionImportSource {
                    agent_id: definition.id,
                    label: definition.label,
                    supported: false,
                    candidates: Vec::new(),
                    error: None,
                }),
                Err(error) => sources.push(SessionImportSource {
                    agent_id: definition.id,
                    label: definition.label,
                    supported: true,
                    candidates: Vec::new(),
                    error: Some(error.message),
                }),
            }
        }
        Ok(SessionImportListing {
            sources,
            expires_at_ms,
            filtered_duplicates,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn import_session(
        &mut self,
        workspace_id: &str,
        candidate_id: &str,
        boot: &LogicBoot,
        config: &Config,
        executor: &mut impl CapabilityExecutor,
        next: &mut u64,
    ) -> Result<Response, ProtocolError> {
        let candidate = self
            .import_candidates
            .remove(candidate_id)
            .ok_or_else(|| bad_request("that import candidate expired; refresh the list"))?;
        let timestamp = now(executor, next)?;
        let workspace = workspace(config, workspace_id)?;
        let folder = workspace
            .folders
            .first()
            .ok_or_else(|| bad_request("workspace has no folders"))?;
        if candidate.expires_at_ms <= timestamp
            || candidate.workspace_id != workspace_id
            || candidate.cwd != folder.root
        {
            return Err(bad_request(
                "that import candidate expired; refresh the list",
            ));
        }
        self.load_catalog(config, executor, next)?;
        if self.loaded.values().any(|live| {
            live.meta.workspace_id == workspace_id
                && live
                    .meta
                    .imported
                    .as_ref()
                    .is_some_and(|value| value.source_key == candidate.source_key)
        }) {
            return Err(conflict("that Agent session has already been imported"));
        }
        let definition = agents::require(boot, config, &candidate.agent_id)?;
        let cwd_locator = FileLocator {
            root: FileRoot::Workspace {
                handle: folder.root_handle.clone(),
            },
            path: String::new(),
        };
        let mut history =
            read_history(&definition, &candidate, &cwd_locator, boot, executor, next)?;
        let source_item_count = history.items.len();
        let (items, omitted, altered) = bound_imported_items(history.items, executor, next)?;
        history.items = items;
        let unavailable = omitted.saturating_add(altered);
        if unavailable > 0 {
            history.warnings.push(format!(
                "导入历史过长，保留了最近 {} 项；其余内容未进入当前可见窗口",
                source_item_count.saturating_sub(unavailable)
            ));
        }
        if history.continuation == ImportContinuation::Native && history.persist.is_none() {
            history.continuation = ImportContinuation::ReadOnly;
            history
                .warnings
                .push("Agent 没有返回可恢复句柄，已按只读历史导入".to_string());
        }
        let (id, created_now) = identity_and_time(executor, next)?;
        let created_at_ms = if history.created_at_ms > 0 {
            history.created_at_ms
        } else {
            created_now
        };
        let updated_at_ms = if history.updated_at_ms > 0 {
            history.updated_at_ms
        } else {
            created_now
        };
        let meta = SessionMeta {
            format: SESSION_FORMAT,
            id,
            workspace_id: workspace_id.to_string(),
            project_key: workspace_project_key(workspace),
            root_handle: folder.root_handle.clone(),
            root: folder.root.clone(),
            cwd_path: String::new(),
            agent_id: definition.id,
            title: history
                .title
                .or_else(|| normalize_title(Some(candidate.title.clone()))),
            model_id: None,
            mode_id: None,
            effort_id: None,
            created_at_ms,
            updated_at_ms,
            archived: false,
            pending_permission: None,
            pending_permission_at_ms: None,
            persist: history.persist,
            lineage: None,
            imported: Some(ImportedSessionMeta {
                source_key: candidate.source_key,
                agent_id: candidate.agent_id,
                continuation: history.continuation,
                warnings: history.warnings,
                coverage: Some(HistoryCoverage {
                    source_item_count: Some(
                        u64::try_from(source_item_count).unwrap_or(u64::MAX),
                    ),
                    retained_item_count: u64::try_from(
                        source_item_count.saturating_sub(unavailable),
                    )
                    .unwrap_or(u64::MAX),
                    omitted_item_count: u64::try_from(unavailable).unwrap_or(u64::MAX),
                    retrieval: if unavailable == 0 {
                        RetrievalCapability::Genehub
                    } else if history.continuation == ImportContinuation::Native {
                        RetrievalCapability::NativeOnly
                    } else {
                        RetrievalCapability::Unavailable
                    },
                    reason: (unavailable > 0).then(|| {
                        "the import retained a recent bounded window and clipped oversized records to finish promptly".to_string()
                    }),
                }),
            }),
            context_seed: None,
        };
        establish(&meta, executor, next)?;
        let lock_resource_id = self.claim_session(&meta, executor, next)?;
        save_meta(&meta, executor, next)?;
        let rows = history
            .items
            .into_iter()
            .map(|item| ChatRow::Item { item })
            .collect::<Vec<_>>();
        append_rows(&meta, &rows, executor, next)?;
        let result = summary(&meta, SessionStatus::Idle);
        self.loaded.insert(
            meta.id.clone(),
            LiveSession {
                meta,
                lock_resource_id,
                seq: 0,
                replay: VecDeque::new(),
                replay_window: config.replay_window.max(1),
                pending_permissions: Vec::new(),
                process: None,
                active_items: Vec::new(),
                active_turn: None,
                rounds: Vec::new(),
                closed: false,
                settled_status: None,
            },
        );
        Ok(Response::reply(Reply::Session(result)))
    }
}

fn import_source_key(agent_id: &str, cwd: &str, source_id: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(agent_id.as_bytes());
    digest.update([0]);
    digest.update(cwd.as_bytes());
    digest.update([0]);
    digest.update(source_id.as_bytes());
    format!("sha256:{:x}", digest.finalize())
}

#[allow(clippy::too_many_arguments)]
fn discover(
    definition: &AgentDefinition,
    cwd: &str,
    cwd_locator: &FileLocator,
    limit: usize,
    boot: &LogicBoot,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<Vec<Candidate>>, ProtocolError> {
    match definition.kind {
        AgentKind::Genet => Ok(None),
        AgentKind::Claude => claude_candidates(cwd, limit, boot, executor, next).map(Some),
        AgentKind::Codex => {
            codex_candidates(definition, cwd, cwd_locator, limit, executor, next).map(Some)
        }
        AgentKind::OpenCode => {
            opencode_candidates(definition, cwd, cwd_locator, limit, executor, next).map(Some)
        }
        AgentKind::Acp => acp_candidates(definition, cwd, cwd_locator, limit, executor, next),
    }
}

fn read_history(
    definition: &AgentDefinition,
    candidate: &CachedImportCandidate,
    cwd: &FileLocator,
    boot: &LogicBoot,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ImportedHistory, ProtocolError> {
    match definition.kind {
        AgentKind::Genet => Err(bad_request("GeneHub Agent does not expose an import store")),
        AgentKind::Claude => claude_history(definition, candidate, boot, executor, next),
        AgentKind::Codex => codex_history(definition, candidate, cwd, executor, next),
        AgentKind::OpenCode => opencode_history(definition, candidate, cwd, executor, next),
        AgentKind::Acp => acp_history(definition, candidate, cwd, executor, next),
    }
}

fn process_spec(
    definition: &AgentDefinition,
    cwd: &FileLocator,
) -> Result<ProcessSpec, ProtocolError> {
    let program = definition
        .program()
        .ok_or_else(|| bad_request("Agent command is empty"))?;
    Ok(ProcessSpec {
        program: program.to_string(),
        args: definition.args().to_vec(),
        env: BTreeMap::new(),
        cwd: Some(cwd.clone()),
        confinement: genet_daemon_logic_api::ConfinementMode::None,
        capture_stdout: true,
        capture_stderr: true,
    })
}

fn run(
    spec: ProcessSpec,
    stdin: Vec<u8>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<u8>, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::Process(ProcessRequest::Run {
        spec,
        stdin,
        timeout_millis: PROVIDER_TIMEOUT_MS,
        max_stdout_bytes: IMPORT_OUTPUT_BYTES,
        max_stderr_bytes: 512 * 1024,
    }))? {
        CapabilityValue::ProcessCompleted {
            code: Some(0),
            stdout,
            ..
        } => Ok(stdout),
        CapabilityValue::ProcessCompleted { code, stderr, .. } => Err(internal(format!(
            "Agent import command exited with {code:?}: {}",
            clip(&String::from_utf8_lossy(&stderr), 1000)
        ))),
        _ => Err(internal("process run returned the wrong value")),
    }
}

fn dialogue(
    spec: ProcessSpec,
    steps: Vec<ProcessDialogueStep>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Value>, ProtocolError> {
    let mut client = Client::new(executor, next);
    let output = match client.call(CapabilityRequest::Process(ProcessRequest::Dialogue {
        spec,
        steps,
        timeout_millis: PROVIDER_TIMEOUT_MS,
        max_stdout_bytes: IMPORT_OUTPUT_BYTES,
        max_stderr_bytes: 512 * 1024,
    }))? {
        CapabilityValue::ProcessCompleted { stdout, .. } => stdout,
        _ => return Err(internal("process dialogue returned the wrong value")),
    };
    Ok(output
        .split(|byte| *byte == b'\n')
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .collect())
}

fn rpc_step(value: Value, id: i64) -> Result<ProcessDialogueStep, ProtocolError> {
    let mut stdin = serde_json::to_vec(&value)
        .map_err(|error| internal(format!("encoding Agent import request: {error}")))?;
    stdin.push(b'\n');
    Ok(ProcessDialogueStep {
        stdin,
        wait_for_line: format!("\"id\":{id}").into_bytes(),
    })
}

fn rpc_result(frames: &[Value], id: i64, method: &str) -> Result<Value, ProtocolError> {
    let frame = frames
        .iter()
        .find(|frame| frame.get("id").and_then(Value::as_i64) == Some(id))
        .ok_or_else(|| internal(format!("Agent did not answer {method}")))?;
    if let Some(error) = frame.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown Agent error");
        return Err(internal(format!("{method} failed: {message}")));
    }
    Ok(frame.get("result").cloned().unwrap_or(Value::Null))
}

fn imported_id(source: &str, index: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(b"genehub-import-item-v1\0");
    digest.update(source.as_bytes());
    digest.update((index as u64).to_le_bytes());
    format!("import-{}", &format!("{:x}", digest.finalize())[..24])
}

fn clip(value: &str, limit: usize) -> String {
    let trimmed = value.trim();
    let mut output = trimmed.chars().take(limit).collect::<String>();
    if trimmed.chars().count() > limit {
        output.push('…');
    }
    output
}

fn codex_rpc(
    definition: &AgentDefinition,
    cwd: &FileLocator,
    method: &str,
    params: Value,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Value, ProtocolError> {
    let mut spec = process_spec(definition, cwd)?;
    spec.args.extend([
        "app-server".to_string(),
        "-c".to_string(),
        r#"approval_policy="never""#.to_string(),
        "-c".to_string(),
        r#"sandbox_mode="danger-full-access""#.to_string(),
    ]);
    let initialize = rpc_step(
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "clientInfo": {
                "name": "codex_app_server_daemon",
                "title": "GeneHub",
                "version": env!("CARGO_PKG_VERSION"),
            }},
        }),
        1,
    )?;
    let mut second = serde_json::to_vec(&json!({
        "jsonrpc": "2.0",
        "method": "initialized",
        "params": {},
    }))
    .map_err(|error| internal(format!("encoding Codex initialized frame: {error}")))?;
    second.push(b'\n');
    second.extend(
        serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params,
        }))
        .map_err(|error| internal(format!("encoding Codex import request: {error}")))?,
    );
    second.push(b'\n');
    let frames = dialogue(
        spec,
        vec![
            initialize,
            ProcessDialogueStep {
                stdin: second,
                wait_for_line: b"\"id\":2".to_vec(),
            },
        ],
        executor,
        next,
    )?;
    rpc_result(&frames, 2, method)
}

fn codex_candidates(
    definition: &AgentDefinition,
    cwd_native: &str,
    cwd: &FileLocator,
    limit: usize,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Candidate>, ProtocolError> {
    let listed = codex_rpc(
        definition,
        cwd,
        "thread/list",
        json!({
            "cwd": cwd_native,
            "limit": limit.clamp(1, 100),
            "sortKey": "updated_at",
            "sortDirection": "desc",
        }),
        executor,
        next,
    )?;
    Ok(listed
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|thread| {
            let source_id = thread.get("id")?.as_str()?.to_string();
            let preview = thread
                .get("preview")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let title = thread
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| preview.lines().next().unwrap_or("Codex 会话"));
            Some(Candidate {
                source_id,
                title: clip(title, 120),
                preview: clip(&preview, 240),
                updated_at_ms: thread
                    .get("updatedAt")
                    .and_then(Value::as_i64)
                    .unwrap_or_default()
                    .saturating_mul(1000),
                continuation: ImportContinuation::Native,
                method: None,
            })
        })
        .collect())
}

fn codex_history(
    definition: &AgentDefinition,
    candidate: &CachedImportCandidate,
    cwd: &FileLocator,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ImportedHistory, ProtocolError> {
    let read = codex_rpc(
        definition,
        cwd,
        "thread/read",
        json!({ "threadId": candidate.source_id, "includeTurns": true }),
        executor,
        next,
    )?;
    let thread = read
        .get("thread")
        .ok_or_else(|| internal("thread/read did not return a thread"))?;
    let mut items = Vec::new();
    let mut index = 0usize;
    for turn in thread
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        for item in turn
            .get("items")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let id = imported_id(&candidate.source_id, index);
            index = index.saturating_add(1);
            match item.get("type").and_then(Value::as_str) {
                Some("userMessage") => {
                    let text = item
                        .get("content")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|part| {
                            (part.get("type").and_then(Value::as_str) == Some("text"))
                                .then(|| part.get("text").and_then(Value::as_str))
                                .flatten()
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !text.is_empty() {
                        items.push(TimelineItem::UserMessage {
                            id,
                            text,
                            attachments: Vec::new(),
                        });
                    }
                }
                Some("agentMessage") => {
                    if let Some(text) = item.get("text").and_then(Value::as_str) {
                        if !text.is_empty() {
                            items.push(TimelineItem::AssistantMessage {
                                id,
                                text: text.to_string(),
                            });
                        }
                    }
                }
                _ => {}
            }
        }
    }
    let preview = thread
        .get("preview")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(ImportedHistory {
        title: thread
            .get("name")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .or_else(|| preview.lines().next())
            .map(|value| clip(value, 120)),
        created_at_ms: thread
            .get("createdAt")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .saturating_mul(1000),
        updated_at_ms: thread
            .get("updatedAt")
            .and_then(Value::as_i64)
            .unwrap_or_default()
            .saturating_mul(1000),
        items,
        persist: Some(PersistHandle {
            agent_id: definition.id.clone(),
            value: json!({ "threadId": candidate.source_id }),
        }),
        continuation: ImportContinuation::Native,
        warnings: Vec::new(),
    })
}

fn acp_probe(
    definition: &AgentDefinition,
    cwd_native: &str,
    cwd: &FileLocator,
    method: &str,
    params: Value,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Value>, ProtocolError> {
    let spec = process_spec(definition, cwd)?;
    let initialize = rpc_step(
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "session": { "configOptions": { "boolean": {} } }
                }
            }
        }),
        1,
    )?;
    let request = rpc_step(
        json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": method,
            "params": params,
        }),
        2,
    )?;
    let frames = dialogue(spec, vec![initialize, request], executor, next)?;
    let _ = cwd_native;
    rpc_result(&frames, 1, "initialize")?;
    rpc_result(&frames, 2, method)?;
    Ok(frames)
}

fn acp_initialize(
    definition: &AgentDefinition,
    cwd: &FileLocator,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Value, ProtocolError> {
    let frames = dialogue(
        process_spec(definition, cwd)?,
        vec![rpc_step(
            json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "session": { "configOptions": { "boolean": {} } }
                    }
                }
            }),
            1,
        )?],
        executor,
        next,
    )?;
    rpc_result(&frames, 1, "initialize")
}

fn acp_candidates(
    definition: &AgentDefinition,
    cwd_native: &str,
    cwd: &FileLocator,
    limit: usize,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<Vec<Candidate>>, ProtocolError> {
    let capability_probe = acp_initialize(definition, cwd, executor, next)?;
    let list_capability = capability_probe
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("sessionCapabilities"))
        .and_then(|session| session.get("list"));
    if !list_capability.is_some_and(|value| !value.is_null() && value.as_bool() != Some(false)) {
        return Ok(None);
    }
    let frames = acp_probe(
        definition,
        cwd_native,
        cwd,
        "session/list",
        json!({ "cwd": cwd_native, "cursor": null }),
        executor,
        next,
    )?;
    let initialized = rpc_result(&frames, 1, "initialize")?;
    let method = if initialized
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("loadSession"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || initialized
            .get("agentCapabilities")
            .and_then(|capabilities| capabilities.get("sessionCapabilities"))
            .and_then(|session| session.get("load"))
            .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
    {
        "session/load"
    } else if initialized
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("sessionCapabilities"))
        .and_then(|session| session.get("resume"))
        .is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
    {
        "session/resume"
    } else {
        return Err(internal(
            "this ACP agent can list sessions but cannot load the selected session",
        ));
    };
    let listed = rpc_result(&frames, 2, "session/list")?;
    let mut candidates = listed
        .get("sessions")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|session| {
            let source_id = session.get("sessionId")?.as_str()?.to_string();
            let title = session
                .get("title")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("ACP 会话")
                .to_string();
            Some(Candidate {
                source_id,
                preview: String::new(),
                title,
                updated_at_ms: acp_time_ms(session.get("updatedAt")),
                continuation: ImportContinuation::Native,
                method: Some(method.to_string()),
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at_ms));
    candidates.truncate(limit);
    Ok(Some(candidates))
}

fn acp_history(
    definition: &AgentDefinition,
    candidate: &CachedImportCandidate,
    cwd: &FileLocator,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ImportedHistory, ProtocolError> {
    let method = candidate
        .method
        .as_deref()
        .ok_or_else(|| bad_request("the ACP import candidate has no load method"))?;
    let frames = acp_probe(
        definition,
        &candidate.cwd,
        cwd,
        method,
        json!({
            "sessionId": candidate.source_id,
            "cwd": candidate.cwd,
            "mcpServers": [],
        }),
        executor,
        next,
    )?;
    let updates = frames
        .iter()
        .filter(|frame| frame.get("method").and_then(Value::as_str) == Some("session/update"))
        .filter_map(|frame| frame.get("params").cloned())
        .collect::<Vec<_>>();
    let items = acp_history_items(&candidate.source_id, &updates);
    if items.is_empty() {
        return Err(internal(
            "the ACP agent loaded the session but did not replay its visible history",
        ));
    }
    let title = items.iter().find_map(|item| match item {
        TimelineItem::UserMessage { text, .. } => Some(clip(text, 120)),
        _ => None,
    });
    let timestamp = now(executor, next)?;
    Ok(ImportedHistory {
        title,
        created_at_ms: timestamp,
        updated_at_ms: timestamp,
        items,
        persist: Some(PersistHandle {
            agent_id: definition.id.clone(),
            value: json!({ "sessionId": candidate.source_id }),
        }),
        continuation: ImportContinuation::Native,
        warnings: Vec::new(),
    })
}

fn acp_time_ms(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or_default(),
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|time| time.timestamp_millis())
            .unwrap_or_default(),
        _ => 0,
    }
}

fn acp_history_items(source_id: &str, updates: &[Value]) -> Vec<TimelineItem> {
    let mut items: Vec<TimelineItem> = Vec::new();
    let mut current_role = "";
    for params in updates {
        let update = params.get("update").unwrap_or(&Value::Null);
        let role = match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("user_message_chunk") => "user",
            Some("agent_message_chunk") => "assistant",
            _ => continue,
        };
        let text = update
            .get("content")
            .and_then(|content| content.get("text"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        if text.is_empty() {
            continue;
        }
        if role == current_role {
            if let Some(last) = items.last_mut() {
                let _ = last.append_text(text);
                continue;
            }
        }
        current_role = role;
        let id = imported_id(source_id, items.len());
        items.push(if role == "user" {
            TimelineItem::UserMessage {
                id,
                text: text.to_string(),
                attachments: Vec::new(),
            }
        } else {
            TimelineItem::AssistantMessage {
                id,
                text: text.to_string(),
            }
        });
    }
    items
}

fn opencode_candidates(
    definition: &AgentDefinition,
    cwd_native: &str,
    cwd: &FileLocator,
    limit: usize,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Candidate>, ProtocolError> {
    let mut spec = process_spec(definition, cwd)?;
    spec.args.extend([
        "session".to_string(),
        "list".to_string(),
        "--format".to_string(),
        "json".to_string(),
        "--max-count".to_string(),
        limit.clamp(1, 100).to_string(),
    ]);
    let stdout = run(spec, Vec::new(), executor, next)?;
    let sessions: Value = serde_json::from_slice(&stdout)
        .map_err(|error| internal(format!("reading OpenCode sessions: {error}")))?;
    let canonical_cwd = canonical_host_path(cwd_native, executor, next)?;
    let mut output = Vec::new();
    for session in sessions.as_array().into_iter().flatten() {
        if let Some(directory) = session.get("directory").and_then(Value::as_str) {
            let Ok(directory) = canonical_host_path(directory, executor, next) else {
                continue;
            };
            if directory != canonical_cwd {
                continue;
            }
        }
        let Some(source_id) = session.get("id").and_then(Value::as_str) else {
            continue;
        };
        let title = session
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("OpenCode 会话")
            .to_string();
        output.push(Candidate {
            source_id: source_id.to_string(),
            preview: String::new(),
            title,
            updated_at_ms: session
                .get("time")
                .and_then(|time| time.get("updated"))
                .and_then(Value::as_i64)
                .or_else(|| session.get("updatedAt").and_then(Value::as_i64))
                .unwrap_or_default(),
            continuation: ImportContinuation::Native,
            method: None,
        });
    }
    output.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at_ms));
    output.truncate(limit);
    Ok(output)
}

fn opencode_history(
    definition: &AgentDefinition,
    candidate: &CachedImportCandidate,
    cwd: &FileLocator,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ImportedHistory, ProtocolError> {
    let mut spec = process_spec(definition, cwd)?;
    spec.args
        .extend(["export".to_string(), candidate.source_id.clone()]);
    let stdout = run(spec, Vec::new(), executor, next)?;
    // Older OpenCode builds printed a status prefix to stdout before the JSON.
    let start = stdout
        .iter()
        .position(|byte| *byte == b'{')
        .ok_or_else(|| internal("OpenCode export did not contain JSON"))?;
    let export: Value = serde_json::from_slice(&stdout[start..])
        .map_err(|error| internal(format!("reading OpenCode export: {error}")))?;
    let session = export.get("info").unwrap_or(&export);
    let messages = export
        .get("messages")
        .or_else(|| export.get("data"))
        .unwrap_or(&Value::Null);
    let mut items = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        let info = message.get("info").unwrap_or(message);
        let role = info.get("role").and_then(Value::as_str);
        let text = message
            .get("parts")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n");
        if text.trim().is_empty() {
            continue;
        }
        let id = imported_id(&candidate.source_id, items.len());
        match role {
            Some("user") => items.push(TimelineItem::UserMessage {
                id,
                text,
                attachments: Vec::new(),
            }),
            Some("assistant") => items.push(TimelineItem::AssistantMessage { id, text }),
            _ => {}
        }
    }
    Ok(ImportedHistory {
        title: session
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .map(str::to_string),
        created_at_ms: session
            .get("time")
            .and_then(|time| time.get("created"))
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        updated_at_ms: session
            .get("time")
            .and_then(|time| time.get("updated"))
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        items,
        persist: Some(PersistHandle {
            agent_id: definition.id.clone(),
            value: json!({ "sessionId": candidate.source_id }),
        }),
        continuation: ImportContinuation::Native,
        warnings: Vec::new(),
    })
}

fn claude_candidates(
    cwd: &str,
    limit: usize,
    boot: &LogicBoot,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Vec<Candidate>, ProtocolError> {
    let Some(directory) = claude_project_directory(cwd, boot, executor, next)? else {
        return Ok(Vec::new());
    };
    let mut client = Client::new(executor, next);
    let entries = match client.call_raw(CapabilityRequest::File(FileRequest::List {
        locator: native_locator(&directory),
    }))? {
        Ok(CapabilityValue::FileEntries(entries)) => entries,
        Ok(_) => return Err(internal("Claude project listing returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(capability_failure(error)),
    };
    let mut files = entries
        .into_iter()
        .filter(|entry| entry.kind == FileKind::File && entry.name.ends_with(".jsonl"))
        .filter_map(|entry| {
            Some((
                entry.native_path?,
                entry.modified_at_millis.unwrap_or_default(),
            ))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, modified)| std::cmp::Reverse(*modified));
    let mut output = Vec::new();
    for (path, modified) in files.into_iter().take(limit.saturating_mul(3).max(limit)) {
        let Some((session_id, title, preview)) = claude_descriptor(&path, executor, next)? else {
            continue;
        };
        output.push(Candidate {
            source_id: session_id,
            title: clip(&title, 120),
            preview: clip(&preview, 240),
            updated_at_ms: modified,
            continuation: ImportContinuation::Native,
            method: None,
        });
        if output.len() >= limit {
            break;
        }
    }
    Ok(output)
}

fn claude_history(
    definition: &AgentDefinition,
    candidate: &CachedImportCandidate,
    boot: &LogicBoot,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<ImportedHistory, ProtocolError> {
    if candidate.source_id.is_empty()
        || !candidate
            .source_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-')
    {
        return Err(bad_request("invalid Claude session id"));
    }
    let directory = claude_project_directory(&candidate.cwd, boot, executor, next)?
        .ok_or_else(|| not_found("Claude project history directory does not exist"))?;
    let path = resolve_existing(
        &directory,
        &format!("{}.jsonl", candidate.source_id),
        executor,
        next,
    )?
    .ok_or_else(|| not_found("the selected Claude session no longer exists"))?;
    let metadata = native_metadata(&path, executor, next)?;
    let mut items = Vec::new();
    let mut title = None;
    let mut created_at_ms = i64::MAX;
    let mut updated_at_ms = 0i64;
    native_lines(&path, executor, next, |line| {
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            return Ok(true);
        };
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return Ok(true);
        }
        if let Some(timestamp) = entry
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
            .map(|value| value.timestamp_millis())
        {
            created_at_ms = created_at_ms.min(timestamp);
            updated_at_ms = updated_at_ms.max(timestamp);
        }
        let Some(text) = claude_message_text(entry.get("message").unwrap_or(&Value::Null)) else {
            return Ok(true);
        };
        let id = imported_id(&candidate.source_id, items.len());
        match entry.get("type").and_then(Value::as_str) {
            Some("user") => {
                title.get_or_insert_with(|| clip(&text, 120));
                items.push(TimelineItem::UserMessage {
                    id,
                    text,
                    attachments: Vec::new(),
                });
            }
            Some("assistant") => items.push(TimelineItem::AssistantMessage { id, text }),
            _ => {}
        }
        Ok(true)
    })?;
    let modified = metadata.modified_at_millis.unwrap_or_default();
    if created_at_ms == i64::MAX {
        created_at_ms = modified;
    }
    if updated_at_ms == 0 {
        updated_at_ms = modified;
    }
    Ok(ImportedHistory {
        title,
        created_at_ms,
        updated_at_ms,
        items,
        persist: Some(PersistHandle {
            agent_id: definition.id.clone(),
            value: json!({ "sessionId": candidate.source_id }),
        }),
        continuation: ImportContinuation::Native,
        warnings: Vec::new(),
    })
}

fn claude_project_directory(
    cwd: &str,
    boot: &LogicBoot,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<String>, ProtocolError> {
    let override_dir = {
        let mut client = Client::new(executor, next);
        match client.call_raw(CapabilityRequest::Environment {
            key: "CLAUDE_CONFIG_DIR".to_string(),
            max_bytes: 32 * 1024,
        })? {
            Ok(CapabilityValue::Text(value)) if !value.is_empty() => Some(value),
            Ok(CapabilityValue::Text(_))
            | Err(genet_daemon_logic_api::CapabilityFailure {
                kind: CapabilityFailureKind::NotFound,
                ..
            }) => None,
            Ok(_) => return Err(internal("environment lookup returned the wrong value")),
            Err(error) => return Err(capability_failure(error)),
        }
    };
    let config = match override_dir {
        Some(path) => resolve_existing("", &path, executor, next)?,
        None => {
            let Some(home) = boot.home_directory.as_deref() else {
                return Ok(None);
            };
            resolve_existing(home, ".claude", executor, next)?
        }
    };
    let Some(config) = config else {
        return Ok(None);
    };
    let canonical = canonical_host_path(cwd, executor, next).unwrap_or_else(|_| cwd.to_string());
    let replaced = canonical
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let encoded = if replaced.chars().count() <= 200 {
        replaced
    } else {
        let mut hash = 0i32;
        for unit in canonical.encode_utf16() {
            hash = hash.wrapping_mul(31).wrapping_add(i32::from(unit));
        }
        format!(
            "{}-{}",
            replaced.chars().take(200).collect::<String>(),
            radix36(hash.unsigned_abs())
        )
    };
    resolve_existing(&config, &format!("projects/{encoded}"), executor, next)
}

fn claude_descriptor(
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<(String, String, String)>, ProtocolError> {
    let mut session_id = None;
    let mut title = None;
    native_lines(path, executor, next, |line| {
        let Ok(entry) = serde_json::from_slice::<Value>(line) else {
            return Ok(true);
        };
        if entry.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            return Ok(true);
        }
        if session_id.is_none() {
            session_id = entry
                .get("sessionId")
                .and_then(Value::as_str)
                .map(str::to_string);
        }
        if title.is_none() && entry.get("type").and_then(Value::as_str) == Some("user") {
            title = claude_message_text(entry.get("message").unwrap_or(&Value::Null));
        }
        Ok(session_id.is_none() || title.is_none())
    })?;
    let source = session_id.or_else(|| {
        path.rsplit(['/', '\\'])
            .next()
            .and_then(|name| name.strip_suffix(".jsonl"))
            .map(str::to_string)
    });
    let Some(source) = source else {
        return Ok(None);
    };
    let title = title.unwrap_or_else(|| format!("Claude 会话 {}", &source[..8.min(source.len())]));
    Ok(Some((source, title.clone(), title)))
}

fn claude_message_text(message: &Value) -> Option<String> {
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => return None,
    };
    (!text.trim().is_empty()).then(|| text.trim().to_string())
}

fn radix36(mut value: u32) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut output = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        output.push(if digit < 10 {
            b'0' + digit
        } else {
            b'a' + digit - 10
        });
        value /= 36;
    }
    output.reverse();
    String::from_utf8(output).expect("base36 is ascii")
}

fn resolve_existing(
    base: &str,
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<Option<String>, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call_raw(CapabilityRequest::File(FileRequest::ResolveHostPath {
        base: base.to_string(),
        path: path.to_string(),
    }))? {
        Ok(CapabilityValue::Text(path)) => Ok(Some(path)),
        Ok(_) => Err(internal("host path resolution returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => Ok(None),
        Err(error) => Err(capability_failure(error)),
    }
}

fn canonical_host_path(
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::CanonicalizeHostPath {
        path: path.to_string(),
    }))? {
        CapabilityValue::Text(path) => Ok(path),
        _ => Err(internal(
            "host path canonicalization returned the wrong value",
        )),
    }
}

fn native_locator(path: &str) -> FileLocator {
    FileLocator {
        root: FileRoot::NativePath,
        path: path.to_string(),
    }
}

fn native_metadata(
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<genet_daemon_logic_api::FileMetadata, ProtocolError> {
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::Metadata {
        locator: native_locator(path),
    }))? {
        CapabilityValue::FileMetadata(metadata) => Ok(metadata),
        _ => Err(internal("native file metadata returned the wrong value")),
    }
}

fn native_lines(
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
    mut visit: impl FnMut(&[u8]) -> Result<bool, ProtocolError>,
) -> Result<(), ProtocolError> {
    let metadata = native_metadata(path, executor, next)?;
    if metadata.kind != FileKind::File {
        return Err(bad_request("Agent history is not a plain file"));
    }
    if metadata.bytes > NATIVE_HISTORY_MAX_BYTES {
        return Err(bad_request(format!(
            "Agent history exceeds {NATIVE_HISTORY_MAX_BYTES} bytes"
        )));
    }
    let mut offset = 0u64;
    let mut pending = Vec::new();
    while offset < metadata.bytes {
        let length = (metadata.bytes - offset).min(1024 * 1024) as u32;
        let mut client = Client::new(executor, next);
        let bytes = match client.call(CapabilityRequest::File(FileRequest::ReadRange {
            locator: native_locator(path),
            offset,
            length,
        }))? {
            CapabilityValue::Bytes(bytes) => bytes,
            _ => return Err(internal("native history read returned the wrong value")),
        };
        if bytes.is_empty() {
            break;
        }
        offset = offset.saturating_add(bytes.len() as u64);
        pending.extend_from_slice(&bytes);
        let split = pending
            .iter()
            .rposition(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(0);
        let mut start = 0usize;
        for end in pending[..split]
            .iter()
            .enumerate()
            .filter_map(|(index, byte)| (*byte == b'\n').then_some(index))
        {
            if end > start && !visit(&pending[start..end])? {
                return Ok(());
            }
            start = end.saturating_add(1);
        }
        pending.drain(..split);
        if pending.len() > 16 * 1024 * 1024 {
            return Err(bad_request("one Agent history record exceeds 16 MiB"));
        }
    }
    if !pending.is_empty() {
        let _ = visit(&pending)?;
    }
    Ok(())
}

fn capability_failure(error: genet_daemon_logic_api::CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}
