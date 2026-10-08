//! Script Agents: every third-party Agent, as a directory the daemon does not
//! understand.
//!
//! The kernel knows how to find a directory (`layout`), keep its `serve`
//! process alive (`host`), talk to it (`rpc`) and give it a Python
//! (`runtime`). What a given Agent is, how it installs, logs in, starts a CLI
//! and translates its events lives in that directory's Python
//! (`docs/agent-serve-protocol.md`, `docs/agent-script-adapters-proposal.md`).

pub mod host;
pub mod layout;
mod pending;
pub mod rpc;
pub mod runtime;

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use genehub_proto::{
    AgentUserRequest, Capabilities, Catalog, ImportContinuation, PermissionOutcome, ProbeState,
    SessionEvent, TimelineItem, TurnError, TurnErrorCode,
};
use serde_json::{json, Value};
use tokio::sync::broadcast;

use self::host::{AgentHost, SessionLink};
use super::{
    AgentAdapter, AgentSession, ImportCandidate, ImportedHistory, PersistHandle, PromptInput,
    ProviderMap, SessionConfig,
};

pub(crate) const SESSION_START: Duration = Duration::from_secs(120);
/// Shorter than the session layer's own handover budget, so a script that
/// stopped reading is restarted before the user's send gives up.
const SEND: Duration = Duration::from_secs(30);
const CONTROL: Duration = Duration::from_secs(15);
const IMPORT_LIST: Duration = Duration::from_secs(15);
const IMPORT_SHOW: Duration = Duration::from_secs(120);
const FORK: Duration = Duration::from_secs(60);

/// What the registry tells everyone watching.
#[derive(Debug, Clone)]
pub enum RegistryEvent {
    /// Some Agent's snapshot changed; read the list again.
    Changed,
    RequestOpened(AgentUserRequest),
    RequestClosed {
        agent_id: String,
        request_id: String,
    },
}

pub struct ScriptAdapter {
    id: String,
    label: String,
    host: Arc<AgentHost>,
}

impl ScriptAdapter {
    pub fn new(host: Arc<AgentHost>) -> Self {
        ScriptAdapter {
            id: host.id.clone(),
            label: host.label(),
            host,
        }
    }

    pub fn host(&self) -> &Arc<AgentHost> {
        &self.host
    }
}

#[async_trait]
impl AgentAdapter for ScriptAdapter {
    fn id(&self) -> &str {
        &self.id
    }

    fn label(&self) -> &str {
        &self.label
    }

    fn capabilities(&self) -> Capabilities {
        self.host.capabilities()
    }

    /// The script owns migrating a stored model, mode or effort that its
    /// catalog no longer offers; the session layer passes them through.
    fn owns_runtime_selection(&self) -> bool {
        true
    }

    async fn probe(&self) -> ProbeState {
        self.host.info().probe
    }

    async fn catalog(&self, _providers: &ProviderMap) -> Catalog {
        self.host.catalog()
    }

    async fn invalidate_catalog(&self) {
        self.host.refresh();
    }

    async fn start(&self, config: SessionConfig) -> Result<Box<dyn AgentSession>> {
        let link = self.host.open_session(&config).await?;
        Ok(Box::new(ScriptSession {
            agent_id: self.id.clone(),
            host: self.host.clone(),
            link,
        }))
    }

    /// A handle the script marked `"resumable": false` (one it imported but
    /// cannot continue natively) makes the session layer seed its own log.
    fn accepts_resume(&self, handle: &PersistHandle) -> bool {
        handle.value.get("resumable").and_then(Value::as_bool) != Some(false)
    }

    async fn list_import_candidates(
        &self,
        cwd: &Path,
        limit: usize,
    ) -> Result<Option<Vec<ImportCandidate>>> {
        if !self.host.ready() {
            return Ok(None);
        }
        let reply = self
            .host
            .call(
                "import.list",
                json!({ "cwd": crate::guest_paths::host_path(cwd), "limit": limit }),
                IMPORT_LIST,
            )
            .await?;
        let Some(candidates) = reply.get("candidates").and_then(Value::as_array) else {
            return Ok(None);
        };
        Ok(Some(
            candidates
                .iter()
                .filter_map(|candidate| {
                    Some(ImportCandidate {
                        source_id: candidate.get("sourceId")?.as_str()?.to_string(),
                        title: text(candidate, "title"),
                        preview: text(candidate, "preview"),
                        updated_at_ms: candidate
                            .get("updatedAtMs")
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                        continuation: continuation(candidate),
                    })
                })
                .collect(),
        ))
    }

    async fn import_history(&self, cwd: &Path, source_id: &str) -> Result<ImportedHistory> {
        let reply = self
            .host
            .call(
                "import.show",
                json!({ "cwd": crate::guest_paths::host_path(cwd), "sourceId": source_id }),
                IMPORT_SHOW,
            )
            .await?;
        let items: Vec<TimelineItem> =
            serde_json::from_value(reply.get("items").cloned().unwrap_or_else(|| json!([])))
                .map_err(|error| anyhow!("Agent 脚本返回的历史不合规：{error}"))?;
        Ok(ImportedHistory {
            title: reply
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
            created_at_ms: reply
                .get("createdAtMs")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            updated_at_ms: reply
                .get("updatedAtMs")
                .and_then(Value::as_i64)
                .unwrap_or(0),
            items,
            persist: reply
                .get("persist")
                .filter(|value| !value.is_null())
                .map(|value| PersistHandle {
                    agent_id: self.id.clone(),
                    value: value.clone(),
                }),
            continuation: continuation(&reply),
            warnings: reply
                .get("warnings")
                .and_then(Value::as_array)
                .map(|warnings| {
                    warnings
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
        })
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn continuation(value: &Value) -> ImportContinuation {
    match value.get("continuation").and_then(Value::as_str) {
        Some("native") => ImportContinuation::Native,
        _ => ImportContinuation::ReadOnly,
    }
}

struct ScriptSession {
    agent_id: String,
    host: Arc<AgentHost>,
    link: Arc<SessionLink>,
}

impl ScriptSession {
    async fn control(&self, method: &str, mut params: Value) -> Result<Value> {
        params["sessionId"] = json!(self.link.id);
        self.host.call(method, params, CONTROL).await
    }
}

#[async_trait]
impl AgentSession for ScriptSession {
    fn events(&self) -> broadcast::Receiver<SessionEvent> {
        self.link.events.subscribe()
    }

    /// The daemon announces the turn before the script hears of it, so
    /// nothing the script emits for it can arrive first.
    async fn send(&self, input: PromptInput) -> Result<String> {
        let turn_id = format!("turn_{}", uuid::Uuid::new_v4().simple());
        self.link.begin_turn(&turn_id);
        let _ = self.link.events.send(SessionEvent::TurnStarted {
            turn_id: turn_id.clone(),
            started_at_ms: 0,
        });
        let params = json!({
            "sessionId": self.link.id,
            "turnId": turn_id,
            "text": input.text,
            "attachments": input.attachments,
        });
        if let Err(error) = self.host.call("session.send", params, SEND).await {
            self.link.end_turn(&turn_id);
            let _ = self.link.events.send(SessionEvent::TurnFailed {
                turn_id,
                error: TurnError {
                    // A crash mid-send is reported by the host as the process
                    // exit; what arrives here is the script refusing the turn.
                    code: TurnErrorCode::Upstream,
                    message: format!("{error:#}"),
                },
            });
            return Err(error);
        }
        Ok(turn_id)
    }

    async fn interrupt(&self) -> Result<()> {
        self.control("session.interrupt", json!({}))
            .await
            .map(|_| ())
    }

    /// Never starts the process just to close a session: when it is not
    /// running (it crashed, or is backing off), nothing of this session is
    /// left in it, and the restart path no longer starts this session again.
    async fn close(&self) -> Result<()> {
        self.host.forget_session(&self.link.id);
        if !self.host.running() {
            return Ok(());
        }
        if let Err(error) = self.control("session.close", json!({})).await {
            // The session is forgotten either way; a script that cannot say
            // so is restarted by the missed deadline, which ends its CLIs.
            tracing::warn!(session = %self.link.id, %error, "script Agent did not confirm session close");
        }
        Ok(())
    }

    async fn set_model(&self, model_id: &str) -> Result<()> {
        self.control("session.setModel", json!({ "modelId": model_id }))
            .await
            .map(|_| ())
    }

    async fn set_mode(&self, mode_id: &str) -> Result<()> {
        self.control("session.setMode", json!({ "modeId": mode_id }))
            .await
            .map(|_| ())
    }

    async fn set_effort(&self, effort_id: &str) -> Result<()> {
        self.control("session.setEffort", json!({ "effortId": effort_id }))
            .await
            .map(|_| ())
    }

    async fn set_fast(&self, fast: bool) -> Result<()> {
        self.control("session.setFast", json!({ "fast": fast }))
            .await
            .map(|_| ())
    }

    async fn set_runtime_axis(&self, axis_id: &str, value_id: &str) -> Result<()> {
        self.control(
            "session.setRuntimeAxis",
            json!({ "axisId": axis_id, "valueId": value_id }),
        )
        .await
        .map(|_| ())
    }

    async fn respond_permission(&self, request_id: &str, outcome: PermissionOutcome) -> Result<()> {
        self.control(
            "session.respond",
            json!({ "requestId": request_id, "outcome": outcome }),
        )
        .await
        .map(|_| ())
    }

    async fn pid(&self) -> Option<u32> {
        self.link.pid()
    }

    async fn fork(&self, checkpoint: &str) -> Result<PersistHandle> {
        let reply = self
            .host
            .call(
                "session.fork",
                json!({ "sessionId": self.link.id, "checkpoint": checkpoint }),
                FORK,
            )
            .await?;
        let value = reply
            .get("persist")
            .cloned()
            .filter(|value| !value.is_null())
            .ok_or_else(|| anyhow!("Agent 脚本没有返回分叉后的会话句柄"))?;
        Ok(PersistHandle {
            agent_id: self.agent_id.clone(),
            value,
        })
    }

    fn persistence(&self) -> Option<PersistHandle> {
        self.link.persist().map(|value| PersistHandle {
            agent_id: self.agent_id.clone(),
            value,
        })
    }
}

impl Drop for ScriptSession {
    fn drop(&mut self) {
        self.host.forget_session(&self.link.id);
    }
}
