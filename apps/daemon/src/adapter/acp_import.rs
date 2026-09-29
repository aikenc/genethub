//! ACP history discovery uses a short-lived probe, independent of live turns.
use super::acp::{
    client_capabilities, resume_method_in, unsupported_request, ResumeMethod, HANDSHAKE_TIMEOUT,
    PROTOCOL_VERSION,
};
use super::stdio::write_json_line;
use super::{ImportCandidate, ImportedHistory, PersistHandle};
use crate::os_process::{Child, ChildStdin, Command};
use anyhow::{anyhow, Context, Result};
use genehub_proto::{ImportContinuation, TimelineItem};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, BufReader};

pub(super) async fn list_candidates(
    program: &Path,
    command: &[String],
    cwd: &Path,
    limit: usize,
) -> Result<Option<Vec<ImportCandidate>>> {
    let mut probe = AcpImportProbe::start(program, command, cwd).await?;
    let outcome = async {
        let initialized = probe.initialize().await?;
        if !acp_can_list_sessions(&initialized) {
            return Ok(None);
        }
        let (listed, _) = probe
            .call(
                "session/list",
                json!({ "cwd": crate::guest_paths::host_path(cwd), "cursor": null }),
            )
            .await?;
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
                Some(ImportCandidate {
                    source_id,
                    preview: String::new(),
                    title,
                    updated_at_ms: acp_time_ms(session.get("updatedAt")),
                    continuation: ImportContinuation::Native,
                })
            })
            .collect::<Vec<_>>();
        candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.updated_at_ms));
        candidates.truncate(limit);
        Ok(Some(candidates))
    }
    .await;
    probe.stop().await;
    outcome
}

pub(super) async fn read_history(
    program: &Path,
    command: &[String],
    agent_id: &str,
    cwd: &Path,
    source_id: &str,
) -> Result<ImportedHistory> {
    let mut probe = AcpImportProbe::start(program, command, cwd).await?;
    let outcome = async {
            let initialized = probe.initialize().await?;
            if !acp_can_list_sessions(&initialized) {
                return Err(crate::rpc_error::failure(genehub_proto::ErrorCode::Unsupported, "this ACP agent does not advertise session import".to_owned()));
            }
            let method = if initialized
                .get("agentCapabilities")
                .and_then(|capabilities| capabilities.get("loadSession"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                "session/load"
            } else {
                match resume_method_in(&initialized) {
                    Some(ResumeMethod::Load) => "session/load",
                    Some(ResumeMethod::Resume) => "session/resume",
                    None => anyhow::bail!("this ACP agent cannot load the selected session"),
                }
            };
            let (_, updates) = probe
                .call(
                    method,
                    json!({ "sessionId": source_id, "cwd": crate::guest_paths::host_path(cwd), "mcpServers": [] }),
                )
                .await?;
            let items = acp_history_items(&updates);
            if items.is_empty() {
                anyhow::bail!(
                    "the ACP agent loaded the session but did not replay its visible history"
                );
            }
            let title = items.iter().find_map(|item| match item {
                TimelineItem::UserMessage { text, .. } => Some(super::clip_text(text, 120)),
                _ => None,
            });
            let now = chrono::Utc::now().timestamp_millis();
            Ok(ImportedHistory {
                title,
                created_at_ms: now,
                updated_at_ms: now,
                items,
                persist: Some(PersistHandle {
                    agent_id: agent_id.to_string(),
                    value: json!({ "sessionId": source_id }),
                }),
                continuation: ImportContinuation::Native,
                warnings: Vec::new(),
            })
        }
        .await;
    probe.stop().await;
    outcome
}

struct AcpImportProbe {
    child: Child,
    stdin: ChildStdin,
    lines: tokio::io::Lines<BufReader<crate::os_process::ChildStdout>>,
    next_id: i64,
}

impl AcpImportProbe {
    async fn start(program: &Path, command: &[String], cwd: &Path) -> Result<Self> {
        let mut spawn = Command::new(program);
        spawn
            .args(&command[1..])
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        super::owned_child(&mut spawn);
        let mut child = spawn
            .spawn()
            .context("spawning ACP agent for session import")?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        Ok(Self {
            child,
            stdin,
            lines: BufReader::new(stdout).lines(),
            next_id: 1,
        })
    }

    async fn initialize(&mut self) -> Result<Value> {
        let (initialized, _) = self
            .call(
                "initialize",
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "clientCapabilities": client_capabilities(),
                }),
            )
            .await?;
        Ok(initialized)
    }

    async fn call(&mut self, method: &str, params: Value) -> Result<(Value, Vec<Value>)> {
        let id = self.next_id;
        self.next_id += 1;
        write_json_line(
            &mut self.stdin,
            &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        )
        .await?;
        tokio::time::timeout(HANDSHAKE_TIMEOUT, async {
            let mut updates = Vec::new();
            while let Some(line) = self.lines.next_line().await? {
                let Ok(frame) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if frame.get("id").and_then(Value::as_i64) == Some(id) {
                    if let Some(error) = frame.get("error") {
                        let message = error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown ACP error");
                        return Err(anyhow!("{method} failed: {message}"));
                    }
                    return Ok((frame.get("result").cloned().unwrap_or(Value::Null), updates));
                }
                if frame.get("method").and_then(Value::as_str) == Some("session/update") {
                    updates.push(frame.get("params").cloned().unwrap_or(Value::Null));
                    continue;
                }
                if let (Some(request_id), Some(request_method)) =
                    (frame.get("id"), frame.get("method").and_then(Value::as_str))
                {
                    write_json_line(
                        &mut self.stdin,
                        &unsupported_request(request_id, request_method),
                    )
                    .await?;
                }
            }
            Err(anyhow!("{method} ended before the ACP agent answered"))
        })
        .await
        .map_err(|_| anyhow!("{method} timed out"))?
    }

    async fn stop(&mut self) {
        super::kill_tree(&mut self.child).await;
    }
}

pub(super) fn acp_can_list_sessions(initialized: &Value) -> bool {
    let value = initialized
        .get("agentCapabilities")
        .and_then(|capabilities| capabilities.get("sessionCapabilities"))
        .and_then(|session| session.get("list"));
    value.is_some_and(|value| !value.is_null() && value.as_bool() != Some(false))
}

pub(super) fn acp_time_ms(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or_default(),
        Some(Value::String(text)) => chrono::DateTime::parse_from_rfc3339(text)
            .map(|time| time.timestamp_millis())
            .unwrap_or_default(),
        _ => 0,
    }
}

pub(super) fn acp_history_items(updates: &[Value]) -> Vec<TimelineItem> {
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
        let id = format!("import-{}", uuid::Uuid::new_v4().simple());
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
                received_at_ms: None,
            }
        });
    }
    items
}
