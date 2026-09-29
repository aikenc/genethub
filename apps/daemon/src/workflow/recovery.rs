//! Platform ceilings for a package-selected recovery flow.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::{fs, io::ErrorKind, path::Path};

const ARCHIVE_LIMIT: usize = 1024 * 1024;
pub(super) const MAX_RECOVERY_RUNS: u32 = 10;
pub(super) const MAX_RECOVERY_LLM_ROUNDS: u64 = 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct HumanExit {
    pub run_id: String,
    pub request_id: String,
    pub pm_session_id: String,
    pub kind: String,
    pub reason: String,
    pub created_at_ms: i64,
    pub answer: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect_error: Option<String>,
    #[serde(default)]
    pub withdrawal_reason: Option<String>,
    #[serde(default)]
    pub budget: Option<genehub_proto::WorkflowBudgetProposal>,
    #[serde(default)]
    pub scope: Option<genehub_proto::WorkflowScopeProposal>,
}

fn exit_path(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    create: bool,
) -> Result<std::path::PathBuf> {
    let relative = Path::new("requests")
        .join(super::request::group_id(run))
        .join("human-exits");
    Ok(runtime
        .directory(&relative, create)?
        .join(format!("{}.json", run.id)))
}

pub(super) fn read_human_exit(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
) -> Result<Option<HumanExit>> {
    let path = exit_path(runtime, run, false)?;
    let metadata = match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() || metadata.len() > 16 * 1024 {
        bail!("invalid Workflow human exit record");
    }
    let exit: HumanExit = serde_json::from_slice(&fs::read(&path)?)?;
    if exit.run_id != run.id || !matches!(exit.kind.as_str(), "a" | "b" | "c" | "d" | "e" | "f") {
        bail!("Workflow human exit identity mismatch");
    }
    Ok(Some(exit))
}

pub(super) fn record_human_response(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    session_id: &str,
    request_id: &str,
    outcome: &genehub_proto::PermissionOutcome,
) -> Result<()> {
    let exit = {
        let _run = super::lock_run(runtime, &run.id)?;
        let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
        let mut exit = read_human_exit(runtime, run)?
            .ok_or_else(|| anyhow::anyhow!("Workflow Human exit disappeared"))?;
        if exit.pm_session_id != session_id || exit.request_id != request_id {
            bail!("Workflow Human answer identity mismatch");
        }
        let selected = match outcome {
            genehub_proto::PermissionOutcome::Selected { option_id } => {
                if !exit_options(&exit.kind)
                    .iter()
                    .any(|(id, _)| id == option_id)
                {
                    bail!("Workflow Human selected an unknown option");
                }
                option_id.clone()
            }
            genehub_proto::PermissionOutcome::Canceled => "cancel".to_owned(),
            _ => bail!("invalid Workflow Human answer"),
        };
        if exit
            .answer
            .as_ref()
            .is_some_and(|answer| answer != &selected)
        {
            bail!("Workflow Human exit already has a different answer");
        }
        exit.effect_error = super::request::apply_human_decision(runtime, run, &exit, &selected)
            .err()
            .map(|error| error.to_string());
        exit.answer = Some(selected);
        crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
        exit
    };
    sync_human_exit_journal(runtime, run, &exit)
}

/// Called under the existing cancellation locks after the native card closed.
pub(super) fn retire_human_exit(
    runtime: &super::RuntimeStore,
    run: &mut super::RunRecord,
    by_agent: bool,
) -> Result<bool> {
    let Some(mut exit) = read_human_exit(runtime, run)? else {
        return Ok(false);
    };
    if exit.answer.is_some() {
        return Ok(false);
    }
    exit.answer = Some(if by_agent { "interrupted" } else { "cancelled" }.into());
    crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
    run.human_exit_journal = Some(super::HumanExitJournal {
        request_id: exit.request_id,
        pm_session_id: exit.pm_session_id,
        kind: exit.kind.clone(),
        effect_applied: exit.effect_error.is_none()
            && ((matches!(exit.kind.as_str(), "a" | "c")
                && exit.answer.as_deref() == Some("approve"))
                || (exit.kind == "b"
                    && exit.scope.is_some()
                    && exit.answer.as_deref() == Some("acceptScope"))),
        answer: exit.answer,
    });
    Ok(true)
}

fn archive_proposal(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    exit: &HumanExit,
) -> Result<()> {
    let relative = Path::new("requests")
        .join(super::request::group_id(run))
        .join("human-exits/history");
    let file = format!(
        "{:x}.json",
        sha2::Sha256::digest(exit.request_id.as_bytes())
    );
    crate::config::save_private(
        &runtime.directory(&relative, true)?.join(file),
        &serde_json::to_vec(exit)?,
    )?;
    Ok(())
}

/// A proposal competes with brief patrol writes after restart. Wait only for
/// admission to the existing locks; never retry an effect or ignore a revision.
async fn lock_decision(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
) -> Result<(super::ExclusiveFileLock, super::ExclusiveFileLock)> {
    let directory = runtime.directory(Path::new("locks"), true)?;
    let run_lock = super::wait_for_exclusive_file_lock(
        &directory.join(format!("{}.lock", run.id)),
        "Workflow Human decision is busy; reread current Run revision",
    )
    .await?;
    let request_lock = super::wait_for_exclusive_file_lock(
        &directory.join(format!("request-{}.lock", super::request::group_id(run))),
        "Workflow request decision is busy; reread current facts",
    )
    .await?;
    Ok((run_lock, request_lock))
}

pub(super) async fn withdraw_human_decision(
    state: &super::Shared,
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    request_id: &str,
    reason: &str,
) -> Result<()> {
    let exit = {
        let (_run, _request) = lock_decision(runtime, run).await?;
        super::require_request_writer(runtime, run)?;
        let current = super::load_run(runtime, &run.id)?;
        if current.revision != run.revision {
            return Err(crate::rpc_error::failure(
                genehub_proto::ErrorCode::Conflict,
                "Workflow revision 冲突：先重新读取 workflow get".to_owned(),
            ));
        }
        let exit =
            read_human_exit(runtime, &current)?.ok_or_else(|| anyhow::anyhow!("没有待答方案"))?;
        if exit.request_id != request_id {
            bail!("待答方案已变化：先读取当前 requestId");
        }
        if exit
            .answer
            .as_deref()
            .is_some_and(|answer| answer != "withdrawn")
        {
            bail!("已答复的方案不能撤回");
        }
        exit
    };
    // Session serializes withdrawal against an answer. Never await its
    // interaction lock while owning a Workflow file lock: answers use the
    // reverse order to persist their authority.
    if exit.answer.as_deref() != Some("withdrawn") {
        state
            .sessions
            .withdraw_workflow_question(&exit.pm_session_id, request_id)
            .await?;
    }
    let (_run, _request) = lock_decision(runtime, run).await?;
    super::require_request_writer(runtime, run)?;
    let current = super::load_run(runtime, &run.id)?;
    let mut exit =
        read_human_exit(runtime, &current)?.ok_or_else(|| anyhow::anyhow!("没有待答方案"))?;
    if exit.request_id != request_id {
        bail!("待答方案已变化：先读取当前 requestId");
    }
    if exit
        .answer
        .as_deref()
        .is_some_and(|answer| answer != "withdrawn")
    {
        bail!("已答复的方案不能撤回");
    }
    exit.answer = Some("withdrawn".into());
    exit.withdrawal_reason = Some(reason.into());
    crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
    archive_proposal(runtime, run, &exit)?;
    let mut current = current;
    current.human_exit_journal = Some(super::HumanExitJournal {
        request_id: exit.request_id,
        pm_session_id: exit.pm_session_id,
        kind: exit.kind,
        answer: exit.answer,
        effect_applied: false,
    });
    current.journal_actor = "pm".into();
    super::save_run(runtime, &current)
}

/// Reconcile the Human card's compact journal marker after its own file is
/// durable. Retrying after a crash commits each reference at most once.
fn sync_human_exit_journal(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    exit: &HumanExit,
) -> Result<()> {
    let marker = super::HumanExitJournal {
        request_id: exit.request_id.clone(),
        pm_session_id: exit.pm_session_id.clone(),
        kind: exit.kind.clone(),
        answer: exit.answer.clone(),
        effect_applied: exit.effect_error.is_none()
            && ((matches!(exit.kind.as_str(), "a" | "c")
                && exit.answer.as_deref() == Some("approve"))
                || (exit.kind == "b"
                    && exit.scope.is_some()
                    && exit.answer.as_deref() == Some("acceptScope"))),
    };
    if run.human_exit_journal.as_ref() == Some(&marker) {
        return Ok(());
    }
    let _run = super::lock_run(runtime, &run.id)?;
    let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
    let mut current = super::load_run(runtime, &run.id)?;
    if read_human_exit(runtime, &current)?
        .is_none_or(|now| now.request_id != exit.request_id || now.answer != exit.answer)
    {
        return Ok(());
    }
    if current.human_exit_journal.as_ref() == Some(&marker) {
        return Ok(());
    }
    current.human_exit_journal = Some(marker);
    super::save_run(runtime, &current)
}

fn exit_options(kind: &str) -> Vec<(String, String)> {
    if let Some(grant) = super::request::human_budget_grant(kind) {
        return vec![
            ("approve".into(), format!("批准{}", grant.description())),
            (
                "reject".into(),
                if kind == "c" {
                    "拒绝，转平台反馈"
                } else {
                    "拒绝，保留受阻需求"
                }
                .into(),
            ),
        ];
    }
    let options: &[(&str, &str)] = match kind {
        "b" => &[
            ("acceptScope", "接受缩减后的目标"),
            ("cancel", "取消用户需求"),
        ],
        "d" => &[
            ("confirmFeedback", "确认并打开预填反馈"),
            ("keepOpen", "保留受阻需求"),
        ],
        "e" => &[
            ("handled", "所需安装或登录已处理"),
            ("abandon", "放弃用户需求"),
        ],
        "f" => &[("pass", "人工验收通过"), ("fail", "人工验收不通过")],
        _ => &[],
    };
    options
        .iter()
        .map(|(id, label)| ((*id).into(), (*label).into()))
        .collect()
}

pub(super) fn classify_human_exit(run: &super::RunRecord) -> Option<&'static str> {
    if run.status() != "blocked" {
        return None;
    }
    let cause = run
        .stop
        .as_ref()
        .map(|stop| stop.cause_code.as_str())
        .unwrap_or("");
    if run.handles.is_empty() {
        return None;
    }
    if cause == "humanAcceptance" {
        return Some("f");
    }
    if cause == "humanScope" {
        return Some("b");
    }
    if cause == "recoveryBudget" {
        return Some("c");
    }
    if matches!(cause, "routeUnavailable" | "recoveryNoExit" | "pmCancel") {
        return None;
    }
    Some("d")
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoredChoice {
    option_id: String,
}

fn choice_file(project_root: &Path, directory: &str, id: &str) -> Result<std::path::PathBuf> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        bail!("Human choice id is not a file name");
    }
    Ok(project_root
        .join(".genethub/components/pm")
        .join(directory)
        .join(format!("{id}.json")))
}

fn read_choice(path: &Path) -> Result<Option<String>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(
            serde_json::from_slice::<StoredChoice>(&bytes)?.option_id,
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

fn write_choice(path: &Path, option_id: &str, replace: bool) -> Result<()> {
    if let Some(existing) = read_choice(path)? {
        if existing == option_id {
            return Ok(());
        }
        if !replace {
            bail!("Human choice already has a different answer");
        }
    }
    crate::config::save_private(
        path,
        &serde_json::to_vec(&StoredChoice {
            option_id: option_id.to_string(),
        })?,
    )
}

/// Recovery-activation approval is not a Run exit. The question id is the
/// file name, so the next wait on the same session cannot erase the answer.
pub(crate) fn record_activation_choice(
    project_root: &Path,
    request_id: &str,
    option_id: &str,
) -> Result<()> {
    if !matches!(option_id, "approve" | "reject") {
        bail!("recovery activation selected an unknown option");
    }
    write_choice(
        &choice_file(project_root, "activation-choices", request_id)?,
        option_id,
        false,
    )
}

pub(crate) fn activation_choice(project_root: &Path, request_id: &str) -> Result<Option<String>> {
    read_choice(&choice_file(
        project_root,
        "activation-choices",
        request_id,
    )?)
}

/// Materialize one pending native Human question per request. The file is the
/// durable Workflow reference; Session storage owns the actual answer card.
pub(super) async fn ensure_human_exit(
    state: &super::Shared,
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    kind: &str,
    proposed_reason: Option<&str>,
) -> Result<HumanExit> {
    ensure_human_decision(state, runtime, run, kind, proposed_reason, None, None).await
}

pub(super) async fn ensure_human_decision(
    state: &super::Shared,
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    kind: &str,
    proposed_reason: Option<&str>,
    budget: Option<genehub_proto::WorkflowBudgetProposal>,
    scope: Option<genehub_proto::WorkflowScopeProposal>,
) -> Result<HumanExit> {
    let (mut exit, created) = {
        let (_run, _request) = lock_decision(runtime, run).await?;
        let existing = read_human_exit(runtime, run)?;
        for sibling in super::request_runs(runtime, super::request::group_id(run))? {
            if sibling.id != run.id {
                if let Some(pending) =
                    read_human_exit(runtime, &sibling)?.filter(|exit| exit.answer.is_none())
                {
                    if proposed_reason.is_some() {
                        bail!(
                            "requirementAwaitingHuman: 请先处理本需求现有问题 {}",
                            pending.request_id
                        );
                    }
                    return Ok(pending);
                }
            }
        }
        if let Some(existing) = existing.as_ref().filter(|exit| {
            exit.answer.is_none()
                || (!(proposed_reason.is_some() && exit.answer.as_deref() == Some("withdrawn"))
                    && exit.kind == kind
                    && proposed_reason.is_none_or(|reason| reason.trim() == exit.reason.trim())
                    && (proposed_reason.is_none()
                        || (exit.budget == budget && exit.scope == scope)))
        }) {
            if proposed_reason.is_some()
                && (existing.kind != kind || existing.budget != budget || existing.scope != scope)
            {
                bail!("requirementAwaitingHuman: 不能替换未答复的方案");
            }
            (existing.clone(), false)
        } else {
            if let Some(proposal) = &budget {
                if kind != "a" {
                    bail!("人工决定类型与预算方案不一致");
                }
                super::request::validate_proposal(runtime, run, proposal)?;
            }
            if let Some(proposal) = &scope {
                if kind != "b"
                    || proposal.goal.trim().is_empty()
                    || proposal.changes.trim().is_empty()
                    || proposal.goal.len() > 16384
                    || proposal.changes.len() > 4096
                {
                    bail!("目标调整方案无效");
                }
            }

            super::require_request_writer(runtime, run)?;
            let current = super::load_run(runtime, &run.id)?;
            if !current.human_decision_ready()
                || super::requirement::terminal(runtime, &current)?
                || current.revision != run.revision
            {
                bail!("Workflow Human exit target changed before question creation");
            }
            let session_id = super::notice_recipient(state, run).await?;
            let reason = proposed_reason
                .or_else(|| run.stop.as_ref().map(|stop| stop.reason.as_str()))
                .unwrap_or(
                    if !run.handles.is_empty()
                        && run.phase() == "closed"
                        && run.status() == "completed"
                    {
                        "恢复审查已完成；请核对 PM 会话与原需求的后续交付决定"
                    } else {
                        "execution blocked"
                    },
                );
            if let Some(previous) = existing.as_ref() {
                if previous.answer.as_deref() == Some("withdrawn")
                    && current.human_exit_journal.as_ref().is_some_and(|marker| {
                        marker.request_id == previous.request_id && marker.answer.is_none()
                    })
                {
                    let mut repaired = current.clone();
                    repaired.human_exit_journal = Some(super::HumanExitJournal {
                        request_id: previous.request_id.clone(),
                        pm_session_id: previous.pm_session_id.clone(),
                        kind: previous.kind.clone(),
                        answer: previous.answer.clone(),
                        effect_applied: false,
                    });
                    repaired.journal_actor = "pm".into();
                    super::save_run(runtime, &repaired)?;
                }
                archive_proposal(runtime, run, previous)?;
            }
            let created_at_ms = super::now_ms().max(
                existing
                    .as_ref()
                    .map(|e| e.created_at_ms.saturating_add(1))
                    .unwrap_or(0),
            );
            let exit = HumanExit {
                run_id: run.id.clone(),
                request_id: if existing.is_some() {
                    format!("workflow-human-{}-decision-{}", run.id, created_at_ms)
                } else {
                    format!("workflow-human-{}", run.id)
                },
                pm_session_id: session_id,
                kind: kind.into(),
                reason: reason.chars().take(4096).collect(),
                created_at_ms,
                answer: None,
                budget: budget.clone(),
                scope: scope.clone(),
                effect_error: None,
                withdrawal_reason: None,
            };
            crate::config::save_private(
                &exit_path(runtime, run, true)?,
                &serde_json::to_vec(&exit)?,
            )?;
            (exit, true)
        }
    };
    sync_human_exit_journal(runtime, run, &exit)?;
    if exit.answer.is_some() {
        apply_answer_action(state, runtime, run, &exit).await?;
        archive_human_resolution(runtime, run, &exit)?;
        return Ok(exit);
    }
    let recipient_live = state
        .sessions
        .summary(&exit.pm_session_id)
        .await
        .is_ok_and(|summary| !summary.archived);
    if !recipient_live {
        let replacement = super::notice_recipient(state, run).await?;
        if replacement == exit.pm_session_id {
            // The project keeps the blocked request visible until a new PM
            // conversation exists; the next patrol can deliver this card.
            return Ok(exit);
        }
        if replacement != exit.pm_session_id {
            let _run = super::lock_run(runtime, &run.id)?;
            let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
            let mut current = read_human_exit(runtime, run)?
                .ok_or_else(|| anyhow::anyhow!("Workflow Human exit disappeared"))?;
            if current.answer.is_none() {
                current.pm_session_id = replacement;
                crate::config::save_private(
                    &exit_path(runtime, run, true)?,
                    &serde_json::to_vec(&current)?,
                )?;
            }
            exit = current;
        }
    }
    if let Some(answer) = state
        .sessions
        .workflow_question_outcome(&exit.pm_session_id, &exit.request_id)
        .await?
    {
        let cancelled = answer == genehub_proto::PermissionOutcome::Canceled;
        let selected = match answer {
            genehub_proto::PermissionOutcome::Selected { option_id } => Some(option_id),
            _ => None,
        };
        if let Some(selected) = selected {
            if !exit_options(&exit.kind)
                .iter()
                .any(|(id, _)| id == &selected)
            {
                bail!("Workflow Human selected an unknown option");
            }
            {
                let _run = super::lock_run(runtime, &run.id)?;
                let _request =
                    super::request::request_lock(runtime, super::request::group_id(run))?;
                let current = read_human_exit(runtime, run)?
                    .ok_or_else(|| anyhow::anyhow!("Human proposal disappeared"))?;
                if current.request_id != exit.request_id || current.answer.is_some() {
                    return Ok(current);
                }
                // The reply is durable even if its effect is now stale. Never
                // keep retrying an invalid approved proposal on every patrol.
                exit.effect_error =
                    super::request::apply_human_decision(runtime, run, &exit, &selected)
                        .err()
                        .map(|error| error.to_string());
                exit.answer = Some(selected);
                crate::config::save_private(
                    &exit_path(runtime, run, true)?,
                    &serde_json::to_vec(&exit)?,
                )?;
            }
            sync_human_exit_journal(runtime, run, &exit)?;
            apply_answer_action(state, runtime, run, &exit).await?;
            archive_human_resolution(runtime, run, &exit)?;
        }
        if cancelled {
            let _run = super::lock_run(runtime, &run.id)?;
            let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
            let mut current = read_human_exit(runtime, run)?
                .ok_or_else(|| anyhow::anyhow!("Human proposal disappeared"))?;
            if current.request_id != exit.request_id || current.answer.is_some() {
                return Ok(current);
            }
            current.answer = Some("withdrawn".into());
            crate::config::save_private(
                &exit_path(runtime, run, true)?,
                &serde_json::to_vec(&current)?,
            )?;
            archive_proposal(runtime, run, &current)?;
            let mut record = super::load_run(runtime, &run.id)?;
            record.human_exit_journal = Some(super::HumanExitJournal {
                request_id: current.request_id.clone(),
                pm_session_id: current.pm_session_id.clone(),
                kind: current.kind.clone(),
                answer: current.answer.clone(),
                effect_applied: false,
            });
            record.journal_actor = "pm".into();
            super::save_run(runtime, &record)?;
            return Ok(current);
        }
        return Ok(exit);
    }
    if state
        .sessions
        .summary(&exit.pm_session_id)
        .await
        .ok()
        .and_then(|summary| summary.interaction_summary)
        .is_some_and(|summary| {
            summary
                .requests
                .iter()
                .any(|pending| pending.request_id != exit.request_id)
        })
    {
        return Ok(exit);
    }
    let options = exit_options(&exit.kind)
        .into_iter()
        .map(|(id, label)| genehub_proto::PermissionOption {
            id,
            label,
            kind: genehub_proto::PermissionOptionKind::AllowOnce,
        })
        .collect();
    let budget_contract = exit.budget.as_ref().map(|proposal| format!("本卡审批总上限：{} 次 Run、{} 次 LLM 请求；预算 revision {}。\n", proposal.max_runs, proposal.max_llm_rounds, proposal.expected_revision)).or_else(|| super::request::human_budget_grant(&exit.kind)
        .map(|grant| format!("本卡审批固定额度：{}（受平台上限约束）。申请原因中的其他数字不改变此额度；不同意该额度请选择拒绝。\n", grant.description()))
        )
        .unwrap_or_default();
    let request = genehub_proto::PermissionRequest {
        summary: None,
        description: Some(format!(
            "{budget_contract}Run {}\n申请原因（PM 或执行记录提供）：{}\n答复会持久记录，相关动作由内核执行或通知 PM 继续。",
            run.id, exit.reason
        )),
        author: None,
        id: exit.request_id.clone(),
        kind: genehub_proto::PermissionRequestKind::Question,
        title: format!("Workflow 请求需要人工决定（出口 {}）", exit.kind),
        tool_call_id: None,
        options,
        questions: None,
    };
    // Publication rechecks this proposal under the Session interaction lock.
    // Holding a Workflow file lock here would invert the answer lock order.
    if let Err(error) = state
        .sessions
        .request_workflow_question_for_run(&exit.pm_session_id, &run.id, request)
        .await
    {
        if created {
            tracing::warn!(run = %run.id, %error, "Workflow Human exit persisted but question delivery will retry");
        }
        return Err(error);
    }
    Ok(exit)
}

fn archive_human_resolution(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    exit: &HumanExit,
) -> Result<()> {
    if exit.kind == "d" || (exit.kind == "c" && exit.answer.as_deref() == Some("reject")) {
        archive_with_result(
            runtime,
            run,
            &format!(
                "human:{}:{}",
                exit.kind,
                exit.answer.as_deref().unwrap_or("unknown")
            ),
        )?;
    }
    Ok(())
}

async fn apply_answer_action(
    state: &super::Shared,
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    exit: &HumanExit,
) -> Result<()> {
    if matches!(exit.answer.as_deref(), Some("cancel" | "abandon")) {
        let current = super::load_run(runtime, &run.id)?;
        let root = super::load_run(runtime, super::request::group_id(&current))?;
        // A deliberate user resume already acknowledges the earlier stop.
        // Re-reading that old card must not cancel the reopened goal again.
        if root.request.as_ref().is_some_and(|link| {
            link.resume_message_id.is_some()
                && !super::request::cancelled(&root)
                && exit.created_at_ms <= link.cancelled_at_ms
        }) {
            return Ok(());
        }
        super::control::cancel(
            state,
            &current.workspace_id,
            &current.id,
            current.revision,
            false,
        )
        .await?;
    }
    if exit.kind == "f" && exit.answer.as_deref() == Some("pass") {
        super::control::complete_human_acceptance(runtime, &run.id)?;
    }
    if let Some(answer) = exit.answer.as_deref() {
        if !matches!(
            answer,
            "cancel" | "abandon" | "pass" | "cancelled" | "interrupted" | "withdrawn"
        ) {
            let _run = super::lock_run(runtime, &run.id)?;
            let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
            let mut current = super::load_run(runtime, &run.id)?;
            let id = format!("flow-human-answer-{}", exit.request_id);
            if current
                .supervision
                .notices
                .iter()
                .all(|notice| notice.id != id)
            {
                current.supervision.notices.push(super::supervision::Notice {
                    id,
                    text: format!("Workflow Human 已回答出口 {}：{}。{} Run {} 仍需 PM 核对请求目标、现有预算与受控后继；请先读取 workflow get/check/journal。", exit.kind, answer,
                        if let Some(error) = &exit.effect_error {
                            format!("批准的方案未生效：{error}；不得按申请额执行。")
                        } else if answer == "approve" {
                            match &exit.budget {
                                Some(proposal) => format!("已记账总上限：{} 次 Run、{} 次 LLM 请求；不得重复追加。", proposal.max_runs, proposal.max_llm_rounds),
                                None => super::request::human_budget_grant(&exit.kind)
                                    .map(|grant| format!("已按本卡固定档位记账：{}；实际总额以 workflow get 为准，不得重复追加。", grant.description()))
                                    .unwrap_or_default(),
                            }
                        } else { String::new() }, run.id),
                    accepted: false,
                    handled: false,
                });
                super::save_run(runtime, &current)?;
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Summary {
    pub run_id: String,
    pub handled_run_id: String,
    pub at_ms: i64,
    pub symptom: String,
    pub root_cause: String,
    pub repair: String,
    pub before_digest: String,
    pub after_digest: Option<String>,
    pub result: String,
    pub journal_run_id: String,
    pub journal_seq: u64,
}

fn read_archive(path: &Path) -> Result<Vec<u8>> {
    let metadata = match crate::config::sensitive_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    crate::config::reject_link_or_reparse(path, &metadata)?;
    if !metadata.is_file() || metadata.len() > ARCHIVE_LIMIT as u64 {
        bail!(
            "recovery archive is not a bounded regular file: {}",
            path.display()
        );
    }
    let bytes = fs::read(path)?;
    if bytes.len() > ARCHIVE_LIMIT {
        bail!("recovery archive grew during read");
    }
    Ok(bytes)
}

fn contains_run(bytes: &[u8], run_id: &str) -> bool {
    for line in bytes
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        if serde_json::from_slice::<Summary>(line).is_ok_and(|summary| summary.run_id == run_id) {
            return true;
        }
    }
    false
}

#[cfg(test)]
pub(super) fn latest(runtime: &super::RuntimeStore) -> Result<Vec<Summary>> {
    let dir = runtime.executor_directory(Path::new(""), false)?;
    latest_in(&dir)
}

#[cfg(test)]
fn latest_in(dir: &Path) -> Result<Vec<Summary>> {
    let mut records = Vec::new();
    for filename in ["recoveries.1.jsonl", "recoveries.jsonl"] {
        for line in read_archive(&dir.join(filename))?
            .split(|byte| *byte == b'\n')
            .filter(|line| !line.is_empty())
        {
            if let Ok(summary) = serde_json::from_slice::<Summary>(line) {
                records.push(summary);
            }
        }
    }
    Ok(records.into_iter().rev().take(20).collect())
}

/// Persist once after the terminal Run snapshot. A replay sees the same Run
/// in either archive file and cannot duplicate its summary.
pub(super) fn archive_terminal(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
) -> Result<()> {
    if run.handles.is_empty() || !matches!(run.status(), "completed" | "cancelled") {
        return Ok(());
    }
    archive_with_result(runtime, run, run.status())
}

fn archive_with_result(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    result: &str,
) -> Result<()> {
    if run.handles.is_empty() {
        return Ok(());
    }
    let scoped = super::RuntimeStore::for_package(
        &runtime.owner_identity,
        &run.workspace_id,
        &runtime.project_root,
        &run.package_id,
    )?;
    let lock_id = format!(
        "recovery-archive-{}",
        &super::hex_digest(run.package_id.as_bytes())[..32]
    );
    let _guard = super::lock_run(&scoped, &lock_id)?;
    let dir = scoped.executor_directory(Path::new(""), true)?;
    let handle = &run.handles[0];
    let target = super::load_run(&scoped, &handle.run_id)?;
    let cause = run
        .nodes
        .values()
        .filter_map(|node| node.reason.as_deref())
        .collect::<Vec<_>>()
        .join("; ");
    // A custom recovery can name its repair node anything. Preserve bounded
    // submitted evidence with its node and key instead of guessing meaning
    // from an id; the archive is context, never an instruction source.
    let repair = recovery_evidence(run);
    let after_digest = super::dispatch_candidate(&runtime.project_root, &scoped)
        .ok()
        .map(|(candidate, _)| candidate.digest);
    let summary = Summary {
        run_id: run.id.clone(),
        handled_run_id: handle.run_id.clone(),
        at_ms: run.updated_at_ms,
        symptom: handle.reason.chars().take(1024).collect(),
        root_cause: cause.chars().take(2048).collect(),
        repair: repair.chars().take(2048).collect(),
        before_digest: target.dcg_digest,
        after_digest,
        result: result.into(),
        journal_run_id: run.id.clone(),
        journal_seq: run.journal_seq,
    };
    append_summary(&dir, &summary)
}

fn recovery_evidence(run: &super::RunRecord) -> String {
    run.nodes
        .iter()
        .flat_map(|(id, node)| {
            node.evidence
                .iter()
                .map(move |(key, value)| format!("{id}.{key}={value}"))
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn append_summary(dir: &Path, summary: &Summary) -> Result<()> {
    let current_path = dir.join("recoveries.jsonl");
    let old_path = dir.join("recoveries.1.jsonl");
    let mut current = read_archive(&current_path)?;
    let old = read_archive(&old_path)?;
    if contains_run(&current, &summary.run_id) || contains_run(&old, &summary.run_id) {
        return Ok(());
    }
    let mut line = serde_json::to_vec(summary)?;
    line.push(b'\n');
    if line.len() > ARCHIVE_LIMIT {
        bail!("recovery summary exceeds archive limit");
    }
    if current.len() + line.len() > ARCHIVE_LIMIT {
        crate::config::save_private(&old_path, &current)?;
        current.clear();
    }
    current.extend(line);
    crate::config::save_private(&current_path, &current)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(id: &str, symptom: String) -> Summary {
        Summary {
            run_id: id.into(),
            handled_run_id: "business".into(),
            at_ms: 1,
            symptom,
            root_cause: String::new(),
            repair: String::new(),
            before_digest: "sha256:before".into(),
            after_digest: None,
            result: "completed".into(),
            journal_run_id: id.into(),
            journal_seq: 2,
        }
    }

    #[test]
    fn archive_rotates_at_one_mib_and_replay_does_not_duplicate() {
        let dir = tempfile::tempdir().unwrap();
        let first = summary("r1", "x".repeat(700_000));
        let second = summary("r2", "y".repeat(700_000));
        append_summary(dir.path(), &first).unwrap();
        append_summary(dir.path(), &second).unwrap();
        append_summary(dir.path(), &second).unwrap();
        let old = read_archive(&dir.path().join("recoveries.1.jsonl")).unwrap();
        let current = read_archive(&dir.path().join("recoveries.jsonl")).unwrap();
        assert!(old.len() <= ARCHIVE_LIMIT && current.len() <= ARCHIVE_LIMIT);
        assert!(contains_run(&old, "r1") && !contains_run(&old, "r2"));
        assert!(contains_run(&current, "r2") && !contains_run(&current, "r1"));
        let latest = latest_in(dir.path()).unwrap();
        assert_eq!(
            latest
                .iter()
                .map(|item| item.run_id.as_str())
                .collect::<Vec<_>>(),
            ["r2", "r1"]
        );
    }

    #[test]
    fn invalid_archived_line_is_ignored_as_untrusted_data() {
        let dir = tempfile::tempdir().unwrap();
        crate::config::save_private(&dir.path().join("recoveries.jsonl"), b"not json\n").unwrap();
        let record = summary("r1", "symptom".into());
        append_summary(dir.path(), &record).unwrap();
        assert_eq!(latest_in(dir.path()).unwrap().len(), 1);
    }

    #[test]
    fn custom_node_name_keeps_submitted_repair_evidence() {
        let mut run: super::super::RunRecord = super::super::tests::fixture_run(serde_json::json!({
            "id": "wr_custom", "workspaceId": "workspace", "parentSessionId": "s_pm",
            "workflowId": "custom-recovery", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "recover", "status": "completed", "revision": 1,
            "definition": {"schema": "genehub.workflow.definition.v2", "id": "custom-recovery", "version": 1, "nodes": []},
            "roles": {}, "nodes": {"fix-process": {"uses": "agent.session", "status": "completed", "evidence": {"changes": "activated"}}},
            "leases": {}, "createdAtMs": 1, "updatedAtMs": 2
        })).unwrap();
        assert_eq!(recovery_evidence(&run), "fix-process.changes=activated");
        run.nodes.clear();
        assert!(recovery_evidence(&run).is_empty());
    }

    #[test]
    fn human_exit_classifier_covers_budget_route_failure_and_acceptance() {
        let mut run: super::super::RunRecord = super::super::tests::fixture_run(serde_json::json!({
            "id": "wr_root", "workspaceId": "workspace", "parentSessionId": "s_pm",
            "workflowId": "direct", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "deliver", "status": "blocked", "revision": 1,
            "definition": {"schema": "genehub.workflow.definition.v2", "id": "direct", "version": 1, "nodes": []},
            "roles": {}, "nodes": {}, "leases": {}, "createdAtMs": 1, "updatedAtMs": 2,
            "stop": {"target": "blocked", "reason": "budget display may change", "causeCode": "requestBudget"}
        })).unwrap();
        assert_eq!(classify_human_exit(&run), None);
        run.handles.push(Handle {
            run_id: "wr_business".into(),
            trigger_seq: 1,
            reason: "failed".into(),
        });
        assert_eq!(classify_human_exit(&run), Some("d"));
        run.stop.as_mut().unwrap().cause_code = "recoveryBudget".into();
        assert_eq!(classify_human_exit(&run), Some("c"));
        run.stop.as_mut().unwrap().cause_code = "routeUnavailable".into();
        assert_eq!(classify_human_exit(&run), None);
        run.stop.as_mut().unwrap().cause_code = "executionException".into();
        assert_eq!(classify_human_exit(&run), Some("d"));
    }

    #[test]
    fn recovery_choices_are_durable_and_conflicting_activation_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let activation = "workflow-human-recovery-activation-0123456789abcdef0123456789abcdef";
        record_activation_choice(root.path(), activation, "approve").unwrap();
        assert_eq!(
            activation_choice(root.path(), activation)
                .unwrap()
                .as_deref(),
            Some("approve")
        );
        let again = record_activation_choice(root.path(), activation, "reject").unwrap_err();
        assert!(again.to_string().contains("different answer"));
    }
}

pub(super) fn builtin_bundle() -> Result<super::Bundle> {
    let source = include_str!("builtin-recovery.yaml");
    let definition: super::WorkflowDefinition = serde_yaml::from_str(source)?;
    super::validate_definition(&definition)?;
    validate_contract(&definition)?;
    let mut roles = std::collections::BTreeMap::new();
    {
        let (id, prompt) = ("recovery-reviewer", "只读复查原用户需求、被处理 Run 的执行与交付状态。先读取 workflow get/check/journal，再依据 requestRunId、parentSessionId、originalMessageId 核对原始用户需求及后续约束，不能只检查子任务提示词。记录症状、根因、已完成工作、未决目标和可验证的后续建议；不能自行取消需求、宣告交付、追加预算或启动同一故障的复查。用 workflow complete --outcome completed --evidence report=<复查报告> 提交报告，然后结束会话。PM 依据报告决定 workflow deliver、workflow recover、workflow dispatch --retry-of 或真实人工待办；业务追加额度用 workflow human --kind a，恢复追加额度用 c，缩减目标用 b，安装或登录用 e，反馈 d 不能代替预算授权。");
        roles.insert(
            id.to_string(),
            super::RoleSnapshot {
                schema: super::ROLE_SCHEMA.into(),
                id: id.into(),
                capability: None,
                tags: vec![crate::agent_routing::TAG_PRO.into()],
                agent_id: None,
                model_id: None,
                mode_id: None,
                runtime_values: Default::default(),
                user_interaction: genehub_proto::SessionUserInteraction::ReadOnly,
                prompt: String::new(),
                prompt_text: prompt.into(),
            },
        );
    }
    Ok(super::Bundle {
        digest: format!("sha256:{:x}", sha2::Sha256::digest(source.as_bytes())),
        definition,
        roles,
        source_files: Default::default(),
    })
}

/// A recovery flow reports through a reachable Worker; PM owns the next decision.
pub(super) fn validate_contract(definition: &super::WorkflowDefinition) -> Result<()> {
    let structure = definition
        .structure
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("recovery flow requires v2 structure"))?;
    let program = workflow_engine::compile(structure.clone())?;
    if !program.tasks().any(|(_, activity, _)| {
        definition
            .nodes
            .iter()
            .any(|node| node.id == *activity && node.uses == "agent.session")
    }) {
        bail!("recovery flow requires a reachable agent.session");
    }
    Ok(())
}

/// Check the separate request-wide allowance before creating a recovery Run.
pub(super) fn trigger_seq(run: &super::RunRecord) -> Option<u64> {
    run.interruption_seq().or(run.supervision.stop_seq)
}

pub(super) fn admit(
    runtime: &super::RuntimeStore,
    target: &super::RunRecord,
    budget: &RecoveryBudget,
    now: i64,
) -> Result<u32> {
    let usage = observe_budget(runtime, target, budget, now)?;
    if usage.runs >= usage.limits.max_runs {
        bail!(RecoveryBudgetExceeded(format!(
            "recoveryBudgetExceeded: request has used all {} recovery Runs",
            usage.limits.max_runs
        )));
    }
    if usage.rounds >= usage.limits.max_llm_rounds {
        bail!(RecoveryBudgetExceeded(
            "recoveryBudgetExceeded: request has exhausted recovery LLM rounds".into()
        ));
    }
    Ok(usage.runs.saturating_add(1))
}

#[derive(Debug)]
pub(super) struct RecoveryBudgetExceeded(pub String);

impl std::fmt::Display for RecoveryBudgetExceeded {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for RecoveryBudgetExceeded {}

struct BudgetObservation {
    limits: RecoveryBudget,
    runs: u32,
    rounds: u64,
}

fn observe_budget(
    runtime: &super::RuntimeStore,
    target: &super::RunRecord,
    budget: &RecoveryBudget,
    _now: i64,
) -> Result<BudgetObservation> {
    budget.validate()?;
    let extra = super::request::recovery_extra(runtime, super::request::group_id(target))?;
    let limits = RecoveryBudget {
        max_runs: budget
            .max_runs
            .saturating_add(extra.max_runs)
            .min(MAX_RECOVERY_RUNS),
        max_llm_rounds: budget
            .max_llm_rounds
            .saturating_add(extra.max_llm_rounds)
            .min(MAX_RECOVERY_LLM_ROUNDS),
    };
    let group = super::request_runs(runtime, super::request::group_id(target))?;
    let recoveries = group
        .iter()
        .filter(|run| !run.handles.is_empty())
        .collect::<Vec<_>>();
    Ok(BudgetObservation {
        limits,
        runs: recoveries.len().min(u32::MAX as usize) as u32,
        rounds: recoveries
            .iter()
            .flat_map(|run| super::request::activities(run))
            .fold(0u64, |sum, activity| {
                sum.saturating_add(activity.llm_rounds)
            }),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Handle {
    pub run_id: String,
    pub trigger_seq: u64,
    pub reason: String,
}

pub(super) fn budget_exhausted(
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    now: i64,
) -> Result<bool> {
    let budget = run.definition.budget.clone().unwrap_or_default();
    let usage = observe_budget(runtime, run, &budget, now)?;
    Ok(usage.rounds >= usage.limits.max_llm_rounds)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryBudget {
    pub max_runs: u32,
    pub max_llm_rounds: u64,
}

impl Default for RecoveryBudget {
    fn default() -> Self {
        Self {
            max_runs: 3,
            max_llm_rounds: 200,
        }
    }
}

impl RecoveryBudget {
    pub(super) fn validate(&self) -> Result<()> {
        if !(1..=MAX_RECOVERY_RUNS).contains(&self.max_runs) {
            bail!("recovery budget.maxRuns 必须在 1..=10 之间");
        }
        if !(1..=MAX_RECOVERY_LLM_ROUNDS).contains(&self.max_llm_rounds) {
            bail!("recovery budget.maxLlmRounds 必须在 1..=1000 之间");
        }
        Ok(())
    }
}
