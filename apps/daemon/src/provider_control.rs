//! A provider-specific transaction, not a grant of machine Settings to Agents.
//! Session records contain plans and receipts only. Credentials stay in config.
use std::path::Path;

use anyhow::{anyhow, bail, ensure, Result};
use genehub_proto::{
    PermissionOption, PermissionOptionKind, PermissionOutcome, PermissionRequest,
    PermissionRequestKind, ProviderDraft, ProviderOperationCommand, ProviderOperationReceipt,
    ProviderValidation,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::config::ProviderConfig;
use crate::state::Shared;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    receipt: ProviderOperationReceipt,
    machine: String,
    baseline: String,
    expected: Option<String>,
    decision: Option<bool>,
    #[serde(default)]
    credential_fingerprint: Option<String>,
    presented: bool,
}

fn operation_lock(state: &Shared, path: &Path) -> Result<std::sync::Arc<tokio::sync::Mutex<()>>> {
    let mut locks = state
        .provider_operations
        .lock()
        .map_err(|_| anyhow!("provider operation lock unavailable"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(path).and_then(std::sync::Weak::upgrade) {
        return Ok(lock);
    }
    ensure!(
        locks.len() < 1024,
        "too many simultaneous provider operations"
    );
    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(path.to_path_buf(), std::sync::Arc::downgrade(&lock));
    Ok(lock)
}
struct OperationFileLock {
    file: std::fs::File,
    path: std::path::PathBuf,
}
impl Drop for OperationFileLock {
    fn drop(&mut self) {
        let _ = crate::fs_lock::unlock(&self.file, &self.path);
    }
}
fn file_lock(path: &Path) -> Result<OperationFileLock> {
    let path = path.with_extension("lock");
    std::fs::create_dir_all(path.parent().expect("operation directory"))?;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&path)?;
    crate::config::restrict_to_owner(&path)?;
    crate::fs_lock::try_lock_exclusive(&file, &path).map_err(|_| {
        anyhow!(
            "provider operation is active on another daemon; inspect its receipt before retrying"
        )
    })?;
    Ok(OperationFileLock { file, path })
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn digest(value: &Option<ProviderConfig>) -> Result<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(value)?)))
}
fn save(path: &Path, record: &Record) -> Result<()> {
    crate::config::save_private(path, &serde_json::to_vec(record)?)
}
fn load(path: &Path) -> Result<Option<Record>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            ensure!(bytes.len() <= 64 * 1024, "provider operation is too large");
            Ok(Some(serde_json::from_slice(&bytes)?))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn action_id(command: &ProviderOperationCommand) -> &str {
    match command {
        ProviderOperationCommand::Prepare { action_id, .. }
        | ProviderOperationCommand::Get { action_id }
        | ProviderOperationCommand::Submit { action_id, .. }
        | ProviderOperationCommand::Verify { action_id } => action_id,
    }
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 96
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn validate(draft: &ProviderDraft) -> Result<()> {
    ensure!(
        valid_id(&draft.provider_id),
        "providerId must be a bounded identifier"
    );
    ensure!(
        !draft.label.trim().is_empty()
            && draft.label.chars().count() <= 120
            && !draft.label.chars().any(char::is_control),
        "provider label is invalid"
    );
    ensure!(draft.base_url.len() <= 2048, "provider address is too long");
    crate::provider::validate_credential_url(&draft.base_url)?;
    ensure!(
        matches!(draft.dialect.as_str(), "openai" | "anthropic"),
        "dialect must be openai or anthropic"
    );
    ensure!(
        draft.models.len() <= 64
            && draft.models.iter().all(|m| !m.trim().is_empty()
                && m.len() <= 200
                && !m.chars().any(char::is_control)),
        "model list is invalid"
    );
    Ok(())
}
fn request(record: &Record) -> PermissionRequest {
    let r = &record.receipt;
    PermissionRequest {
        id: format!("provider-{}", r.action_id),
        kind: PermissionRequestKind::ProviderConfiguration,
        title: format!("配置模型服务：{}", r.draft.label),
        detail: Some(format!(
            "目标：当前连接的机器\nProvider：{}\n协议：{}\n地址：{}\n模型：{}\n{}",
            r.draft.provider_id,
            r.draft.dialect,
            r.draft.base_url,
            if r.draft.models.is_empty() {
                "由服务商发现".into()
            } else {
                r.draft.models.join(", ")
            },
            if r.replaces_endpoint {
                "将更换地址或协议，需要输入新密钥；原密钥不会发送到新地址。"
            } else if r.key_required {
                "需要你输入密钥；密钥直接保存到机器，不进入对话。"
            } else {
                "可沿用当前地址已保存的密钥，或输入新密钥。"
            }
        )),
        tool_call_id: None,
        questions: None,
        options: vec![
            PermissionOption {
                id: "approve".into(),
                label: "保存并验证".into(),
                kind: PermissionOptionKind::AllowOnce,
            },
            PermissionOption {
                id: "reject".into(),
                label: "取消配置".into(),
                kind: PermissionOptionKind::Reject,
            },
        ],
    }
}
fn check_owner(state: &Shared, record: &Record, session_id: &str, id: &str) -> Result<()> {
    ensure!(
        record.machine == state.machine.fingerprint(),
        "provider operation belongs to another machine"
    );
    ensure!(
        record.receipt.session_id == session_id && record.receipt.action_id == id,
        "provider operation identity mismatch"
    );
    validate(&record.receipt.draft)
}
async fn reconcile(state: &Shared, path: &Path, record: &mut Record) -> Result<()> {
    if record.receipt.validation.status == "verifying" {
        record.receipt.validation.status = "interrupted".into();
        record.receipt.validation.detail = "验证被中断；请显式重新验证，配置不会重复保存".into();
        save(path, record)?;
    }
    if record.receipt.state == "applying" {
        let current = state
            .config
            .read()
            .await
            .agents
            .providers
            .get(&record.receipt.draft.provider_id)
            .cloned();
        record.receipt.state = if record.expected.as_deref() == Some(digest(&current)?.as_str()) {
            "saved"
        } else {
            "unknown"
        }
        .into();
        record.receipt.updated_at_ms = now();
        save(path, record)?;
    }
    Ok(())
}
async fn continue_session(state: &Shared, record: &Record) -> Result<()> {
    if !matches!(record.receipt.state.as_str(), "saved" | "rejected") {
        return Ok(());
    }
    let id = format!("provider-{}", record.receipt.action_id);
    // Active stop/close removes the card: it must not recreate the obligation.
    if !state
        .sessions
        .pending_questions(&record.receipt.session_id)
        .await?
        .iter()
        .any(|r| r.id == id && r.kind == PermissionRequestKind::ProviderConfiguration)
    {
        return Ok(());
    }
    state
        .sessions
        .respond_permission(
            &record.receipt.session_id,
            &id,
            PermissionOutcome::Selected {
                option_id: if record.receipt.state == "saved" {
                    "approve"
                } else {
                    "reject"
                }
                .into(),
            },
            &state.providers().await,
        )
        .await
}

async fn verify_record(state: &Shared, path: &Path, record: &mut Record) -> Result<()> {
    let config = state
        .config
        .read()
        .await
        .agents
        .providers
        .get(&record.receipt.draft.provider_id)
        .cloned();
    ensure!(
        Some(digest(&config)?) == record.expected,
        "provider changed after this receipt; prepare a fresh operation"
    );
    if record.receipt.validation.status == "ready" {
        return Ok(());
    }
    record.receipt.validation.status = "verifying".into();
    save(path, record)?;
    record.receipt.validation = crate::provider::verify(
        &record.receipt.draft.provider_id,
        &config.unwrap_or_default(),
    )
    .await;
    let current = state
        .config
        .read()
        .await
        .agents
        .providers
        .get(&record.receipt.draft.provider_id)
        .cloned();
    if Some(digest(&current)?) != record.expected {
        record.receipt.validation = ProviderValidation {
            status: "stale".into(),
            detail: "验证期间配置已改变，请重新准备配置请求".into(),
            model: None,
        };
    }
    record.receipt.updated_at_ms = now();
    save(path, record)?;
    Ok(())
}

pub(crate) async fn execute(
    state: &Shared,
    session_id: &str,
    command: ProviderOperationCommand,
) -> Result<ProviderOperationReceipt> {
    let id = action_id(&command).to_owned();
    ensure!(
        valid_id(&id),
        "actionId must be a stable identifier of at most 96 characters"
    );
    let summary = state.sessions.summary(session_id).await?;
    ensure!(
        summary.managed.is_none(),
        "provider configuration needs an ordinary Human-controlled Session"
    );
    let path = state
        .sessions
        .provider_operation_path(session_id, &id)
        .await?;
    let lock = operation_lock(state, &path)?;
    let _guard = lock.lock().await;
    let _file_guard = file_lock(&path)?;
    let mut record = load(&path)?;
    if let Some(record) = &mut record {
        check_owner(state, record, session_id, &id)?;
        reconcile(state, &path, record).await?;
    }
    match command {
        ProviderOperationCommand::Prepare { draft, .. } => {
            validate(&draft)?;
            if let Some(existing) = &record {
                ensure!(
                    existing.receipt.draft == draft,
                    "same actionId cannot change its configuration"
                );
            } else {
                if let Some(parent) = path.parent() {
                    let count = match std::fs::read_dir(parent) {
                        Ok(entries) => entries
                            .filter_map(Result::ok)
                            .filter(|entry| {
                                entry.path().extension().is_some_and(|ext| ext == "json")
                            })
                            .count(),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
                        Err(e) => return Err(e.into()),
                    };
                    ensure!(
                        count < 64,
                        "this Session already has 64 provider operations"
                    );
                }
                let original = state
                    .config
                    .read()
                    .await
                    .agents
                    .providers
                    .get(&draft.provider_id)
                    .cloned();
                let old = original.clone().unwrap_or_default();
                let resolved = crate::provider::resolve(&draft.provider_id, &old);
                let replaces_endpoint = original.is_some()
                    && (resolved.base_url.as_deref() != Some(draft.base_url.as_str())
                        || resolved.dialect.as_str() != draft.dialect);
                record = Some(Record {
                    receipt: ProviderOperationReceipt {
                        action_id: id.clone(),
                        session_id: session_id.into(),
                        draft,
                        state: "pending".into(),
                        key_required: replaces_endpoint
                            || old.api_key.as_deref().is_none_or(str::is_empty),
                        replaces_endpoint,
                        validation: ProviderValidation {
                            status: "unverified".into(),
                            detail: "尚未验证".into(),
                            model: None,
                        },
                        updated_at_ms: now(),
                    },
                    machine: state.machine.fingerprint(),
                    baseline: digest(&original)?,
                    expected: None,
                    decision: None,
                    credential_fingerprint: None,
                    presented: false,
                });
                save(&path, record.as_ref().expect("created"))?;
            }
            let record = record.as_mut().expect("created");
            if record.receipt.state == "pending" {
                let pending = state
                    .sessions
                    .pending_questions(session_id)
                    .await?
                    .iter()
                    .any(|request| {
                        request.id == format!("provider-{id}")
                            && request.kind == PermissionRequestKind::ProviderConfiguration
                    });
                if record.presented && !pending {
                    record.receipt.state = "rejected".into();
                    record.decision = Some(false);
                    save(&path, record)?;
                } else {
                    state
                        .sessions
                        .request_provider_configuration(session_id, request(record))
                        .await?;
                    record.presented = true;
                    save(&path, record)?;
                }
            }
        }
        ProviderOperationCommand::Submit {
            approved, api_key, ..
        } => {
            ensure!(
                api_key
                    .as_ref()
                    .is_none_or(|key| key.len() <= 16 * 1024 && !key.chars().any(char::is_control)),
                "credential input is invalid"
            );
            let record = record
                .as_mut()
                .ok_or_else(|| anyhow!("provider operation not found"))?;
            if let Some(decision) = record.decision {
                ensure!(
                    decision == approved,
                    "operation already has a different Human decision"
                );
                if let Some(key) = api_key.as_deref().filter(|key| !key.is_empty()) {
                    let offered = format!("{:x}", Sha256::digest(key.as_bytes()));
                    ensure!(record.credential_fingerprint.as_deref() == Some(offered.as_str()), "operation already accepted a different credential; use a fresh actionId for a credential change");
                }

                ensure!(
                    matches!(record.receipt.state.as_str(), "saved" | "rejected"),
                    "operation outcome is uncertain; inspect it, do not repeat the mutation"
                );
            } else {
                ensure!(
                    record.receipt.state == "pending"
                        || (!approved && record.receipt.state == "stale"),
                    "operation is not awaiting confirmation"
                );
                state.sessions.apply_provider_confirmation(session_id, &format!("provider-{id}"), async {
                if !approved {
                    record.decision = Some(false);
                    record.receipt.state = "rejected".into();
                    save(&path, record)?;
                } else {
                    let mut config = state.config.write().await;
                    let original = config
                        .agents
                        .providers
                        .get(&record.receipt.draft.provider_id)
                        .cloned();
                    if digest(&original)? != record.baseline {
                        record.receipt.state = "stale".into();
                        save(&path, record)?;
                        bail!("provider changed after preparation; cancel this request and prepare a fresh actionId");
                    }
                    let mut entry = original.unwrap_or_default();
                    let draft = &record.receipt.draft;
                    if record.receipt.replaces_endpoint {
                        entry.api_key = None;
                        entry.model_inputs.clear();
                    }
                    if let Some(key) = api_key {
                        entry.api_key = (!key.is_empty()).then_some(key);
                    }
                    ensure!(
                        entry.api_key.as_deref().is_some_and(|key| !key.is_empty()),
                        "enter a credential in the workbench to save this configuration"
                    );
                    entry.base_url = Some(draft.base_url.clone());
                    entry.label = Some(draft.label.clone());
                    entry.dialect = Some(draft.dialect.clone());
                    entry.models = draft.models.clone();
                    record.credential_fingerprint = entry
                        .api_key
                        .as_ref()
                        .map(|key| format!("{:x}", Sha256::digest(key.as_bytes())));
                    record.expected = Some(digest(&Some(entry.clone()))?);
                    record.decision = Some(true);
                    record.receipt.state = "applying".into();
                    save(&path, record)?;
                    // Config lock protects compare + atomic save from every existing settings writer.
                    let mut next = config.clone();
                    next.agents
                        .providers
                        .insert(draft.provider_id.clone(), entry);
                    next.save(&state.paths.config_file())?;
                    *config = next;
                    record.receipt.state = "saved".into();
                    record.receipt.updated_at_ms = now();
                    save(&path, record)?;
                    drop(config);
                }
                Ok(())
                }).await?;
                if approved {
                    verify_record(state, &path, record).await?;
                }
            }
        }
        ProviderOperationCommand::Verify { .. } => {
            let record = record
                .as_mut()
                .ok_or_else(|| anyhow!("provider operation not found"))?;
            ensure!(
                record.receipt.state == "saved",
                "only a saved operation can be verified"
            );
            verify_record(state, &path, record).await?;
        }
        ProviderOperationCommand::Get { .. } => {}
    }
    let record = record.ok_or_else(|| anyhow!("provider operation not found"))?;
    continue_session(state, &record).await?;
    Ok(record.receipt)
}

/// Reconcile only a pending card in its original Session; no scan of credentials
/// or replay of secret input is necessary after a crash between save and resume.
pub(crate) async fn recover(state: &Shared, session_id: &str, request_id: &str) -> Result<()> {
    let Some(id) = request_id.strip_prefix("provider-") else {
        return Ok(());
    };
    ensure!(valid_id(id), "invalid provider request identity");
    let path = state
        .sessions
        .provider_operation_path(session_id, id)
        .await?;
    let lock = operation_lock(state, &path)?;
    let Ok(_guard) = lock.try_lock() else {
        return Ok(());
    };
    let _file_guard = file_lock(&path)?;
    if let Some(mut record) = load(&path)? {
        check_owner(state, &record, session_id, id)?;
        reconcile(state, &path, &mut record).await?;
        continue_session(state, &record).await?;
    }
    Ok(())
}
