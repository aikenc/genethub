//! Recovery admission and durable request-scoped Human decisions.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::{fs, io::ErrorKind, path::Path};

const ARCHIVE_LIMIT: usize = 1024 * 1024;

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
    #[serde(default)]
    pub budget: Option<genehub_proto::WorkflowBudgetProposal>,
    #[serde(default)]
    pub scope: Option<genehub_proto::WorkflowScopeProposal>,
    #[serde(default)]
    pub effect_error: Option<String>,
}

fn exit_path(runtime: &super::RuntimeStore, run: &super::RunRecord, create: bool) -> Result<std::path::PathBuf> {
    let relative = Path::new("requests").join(super::request::group_id(run)).join("human-exits");
    Ok(runtime.directory(&relative, create)?.join(format!("{}.json", run.id)))
}

pub(super) fn read_human_exit(runtime: &super::RuntimeStore, run: &super::RunRecord) -> Result<Option<HumanExit>> {
    let path = exit_path(runtime, run, false)?;
    let metadata = match crate::config::sensitive_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    crate::config::reject_link_or_reparse(&path, &metadata)?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 { bail!("invalid Workflow human exit record"); }
    let exit: HumanExit = serde_json::from_slice(&fs::read(&path)?)?;
    if exit.run_id != run.id || !matches!(exit.kind.as_str(), "a" | "b" | "c" | "d" | "e" | "f") {
        bail!("Workflow human exit identity mismatch");
    }
    Ok(Some(exit))
}

/// Called under the existing cancellation locks after the native card closed.
pub(super) fn retire_human_exit(runtime: &super::RuntimeStore, run: &mut super::RunRecord, by_agent: bool) -> Result<bool> {
    let Some(mut exit) = read_human_exit(runtime, run)? else { return Ok(false); };
    if exit.answer.is_some() { return Ok(false); }
    exit.answer = Some(if by_agent { "interrupted" } else { "cancelled" }.into());
    crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
    run.human_exit_journal = Some(super::HumanExitJournal {
        request_id: exit.request_id, pm_session_id: exit.pm_session_id,
        kind: exit.kind, answer: exit.answer, effect_applied: false,
    });
    Ok(true)
}

/// Reconcile the Human card's compact journal marker after its own file is
/// durable. Retrying after a crash commits each reference at most once.
fn sync_human_exit_journal(runtime: &super::RuntimeStore, run: &super::RunRecord,
    exit: &HumanExit) -> Result<()> {
    let marker = super::HumanExitJournal {
        request_id: exit.request_id.clone(),
        pm_session_id: exit.pm_session_id.clone(),
        kind: exit.kind.clone(),
        answer: exit.answer.clone(),
        effect_applied: exit.effect_error.is_none() && ((exit.kind == "a" && exit.answer.as_deref() == Some("approve") && exit.budget.is_some())
            || (exit.kind == "b" && exit.answer.as_deref() == Some("acceptScope") && exit.scope.is_some())),
    };
    if run.human_exit_journal.as_ref() == Some(&marker) { return Ok(()); }
    let _run = super::lock_run(runtime, &run.id)?;
    let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
    let mut current = super::load_run(runtime, &run.id)?;
    if current.human_exit_journal.as_ref() == Some(&marker) { return Ok(()); }
    current.human_exit_journal = Some(marker);
    super::save_run(runtime, &current)
}

fn display_duration(seconds: u64) -> String {
    let (hours, minutes, seconds) = (seconds / 3600, seconds % 3600 / 60, seconds % 60);
    match (hours, minutes, seconds) {
        (0, 0, s) => format!("{s} 秒"),
        (0, m, 0) => format!("{m} 分钟"),
        (0, m, s) => format!("{m} 分 {s} 秒"),
        (h, 0, 0) => format!("{h} 小时"),
        (h, m, _) => format!("{h} 小时 {m} 分"),
    }
}

fn exit_options(kind: &str) -> Vec<(String, String)> {
    let options: &[(&str, &str)] = match kind {
        "a" | "c" => &[("approve", "批准该预算方案"), ("reject", "暂不追加")],
        "b" => &[("acceptScope", "接受调整后的目标"), ("keepScope", "保留当前目标"), ("cancel", "取消用户需求")],
        "d" => &[("confirmFeedback", "确认并打开预填反馈"), ("keepOpen", "保留受阻需求")],
        "e" => &[("handled", "所需安装或登录已处理"), ("abandon", "放弃用户需求")],
        "f" => &[("pass", "人工验收通过"), ("fail", "人工验收不通过")],
        _ => &[],
    };
    options.iter().map(|(id, label)| ((*id).into(), (*label).into())).collect()
}

/// The stop that ended this Run's latest execution segment, recorded when
/// that state committed. Runs stopped before the boundary existed return None.
pub(super) fn trigger_seq(run: &super::RunRecord) -> Option<u64> {
    if let Some(seq) = run.interruption_seq() { return Some(seq); }
    if !super::request::stopped(run) { return None; }
    run.supervision.execution.as_ref().and_then(|clock| clock.stop_seq)
}

pub(super) fn classify_human_exit(run: &super::RunRecord) -> Option<&'static str> {
    if !run.handles.is_empty() && run.phase() == "closed" && run.status() == "completed" {
        let answer_ms = run.definition.pm_answer_seconds.unwrap_or(DEFAULT_PM_ANSWER_SECONDS)
            .saturating_mul(1000).min(i64::MAX as u64) as i64;
        return (super::now_ms().saturating_sub(run.updated_at_ms) >= answer_ms).then_some("d");
    }
    if run.status() != "blocked" { return None; }
    let cause = run.stop.as_ref().map(|stop| stop.cause_code.as_str()).unwrap_or("");
    if run.handles.is_empty() {
        if matches!(cause, "requestBudget" | "routeUnavailable") {
            let answer_ms = DEFAULT_PM_ANSWER_SECONDS.saturating_mul(1000).min(i64::MAX as u64) as i64;
            return (super::now_ms().saturating_sub(run.updated_at_ms) >= answer_ms).then_some("d");
        }
        return None;
    }
    if cause == "humanAcceptance" { return Some("f"); }
    if matches!(cause, "routeUnavailable" | "requestBudget") {
        let answer_ms = run.definition.pm_answer_seconds.unwrap_or(DEFAULT_PM_ANSWER_SECONDS)
            .saturating_mul(1000).min(i64::MAX as u64) as i64;
        return (super::now_ms().saturating_sub(run.updated_at_ms) >= answer_ms).then_some("d");
    }
    // A reviewer can recommend cancellation, but only PM may execute it.
    // Keep the request visible while PM acts; a missed PM deadline is d.
    if matches!(cause, "recoveryNoExit" | "pmCancel") {
        let answer_ms = run.definition.pm_answer_seconds.unwrap_or(DEFAULT_PM_ANSWER_SECONDS)
            .saturating_mul(1000).min(i64::MAX as u64) as i64;
        return (super::now_ms().saturating_sub(run.updated_at_ms) >= answer_ms).then_some("d");
    }
    Some("d")
}

/// Materialize one current native Human question per original request. The file is the
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
        let _run = super::lock_run(runtime, &run.id)?;
        let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
        let existing = read_human_exit(runtime, run)?;
        // One pending Human decision for the whole request. Reuse the existing
        // native question and per-Run receipts; do not add another queue/store.
        for sibling in super::request_runs(runtime, super::request::group_id(run))? {
            if sibling.id != run.id {
                if let Some(pending) = read_human_exit(runtime, &sibling)?.filter(|e| e.answer.is_none()) {
                    if proposed_reason.is_some() {
                        bail!("requirementAwaitingHuman: 请先处理本需求现有问题 {}", pending.request_id);
                    }
                    return Ok(pending);
                }
            }
        }
        if let Some(existing) = existing.as_ref().filter(|exit| exit.answer.is_none()
            || (exit.kind == kind && proposed_reason.is_none_or(|reason| reason.trim() == exit.reason.trim())
                && (proposed_reason.is_none() || (exit.budget == budget && exit.scope == scope)))) {
            if proposed_reason.is_some() && (existing.kind != kind || existing.budget != budget || existing.scope != scope) {
                bail!("requirementAwaitingHuman: 不能替换未答复的方案");
            }
            (existing.clone(), false)
        } else {
            match kind {
                "a" => super::request::validate_proposal(runtime, run,
                    budget.as_ref().ok_or_else(|| anyhow::anyhow!("预算卡必须提供明确的请求次数和时间方案"))?)?,
                "b" => {
                    let proposal = scope.as_ref().ok_or_else(|| anyhow::anyhow!("范围卡必须提供新目标及具体删减内容"))?;
                    if proposal.goal.trim().is_empty() || proposal.changes.trim().is_empty()
                        || proposal.goal.len() > 16_384 || proposal.changes.len() > 4096 {
                        bail!("目标及变更说明不能为空或超出大小限制");
                    }
                }
                "d" | "e" | "f" => {}
                _ => bail!("未知人工决定类型；预算统一使用 a"),
            }
            if (kind != "a" && budget.is_some()) || (kind != "b" && scope.is_some()) {
                bail!("人工决定类型与方案不一致");
            }
            super::require_request_writer(runtime, run)?;
            let current = super::load_run(runtime, &run.id)?;
            if current.unfinished()
                || super::requirement::terminal(runtime, &current)? || current.revision != run.revision {
                bail!("Workflow Human exit target changed before question creation");
            }
            let session_id = super::notice_recipient(state, run).await?;
            let reason = proposed_reason.or_else(|| run.stop.as_ref().map(|stop| stop.reason.as_str()))
                .unwrap_or(if !run.handles.is_empty() && run.phase() == "closed" && run.status() == "completed" {
                    "恢复审查已完成，但 PM 未在期限内落实后继执行、交付决定或人工待办；请核对 PM 会话与原需求"
                } else { "execution blocked" });
            let created_at_ms = super::now_ms().max(existing.as_ref().map(|e| e.created_at_ms.saturating_add(1)).unwrap_or(0));
            let exit = HumanExit {
                run_id: run.id.clone(), request_id: if existing.is_some() {
                    format!("workflow-human-{}-decision-{}", run.id, created_at_ms)
                } else { format!("workflow-human-{}", run.id) },
                pm_session_id: session_id, kind: kind.into(),
                reason: reason.chars().take(4096).collect(), created_at_ms,
                answer: None, budget: budget.clone(), scope: scope.clone(), effect_error: None,
            };
            crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
            (exit, true)
        }
    };
    sync_human_exit_journal(runtime, run, &exit)?;
    if exit.answer.is_some() {
        apply_answer_action(state, runtime, run, &exit).await?;
        archive_human_resolution(runtime, run, &exit)?;
        return Ok(exit);
    }
    let recipient_live = state.sessions.summary(&exit.pm_session_id).await
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
            let mut current = read_human_exit(runtime, run)?.ok_or_else(|| anyhow::anyhow!("Workflow Human exit disappeared"))?;
            if current.answer.is_none() {
                current.pm_session_id = replacement;
                crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&current)?)?;
            }
            exit = current;
        }
    }
    if let Some(answer) = state.sessions.workflow_question_outcome(&exit.pm_session_id, &exit.request_id).await? {
        let selected = match answer {
            genehub_proto::PermissionOutcome::Selected { option_id } => Some(option_id),
            _ => None,
        };
        if let Some(selected) = selected {
            if !exit_options(&exit.kind).iter().any(|(id, _)| id == &selected) {
                bail!("Workflow Human selected an unknown option");
            }
            {
                let _run = super::lock_run(runtime, &run.id)?;
                let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
                // The reply is durable even if its effect is now stale. Never
                // keep retrying an invalid approved proposal on every patrol.
                exit.effect_error = super::request::apply_human_decision(runtime, run, &exit, &selected)
                    .err().map(|error| error.to_string());
                exit.answer = Some(selected);
                crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
            }
            sync_human_exit_journal(runtime, run, &exit)?;
            apply_answer_action(state, runtime, run, &exit).await?;
            archive_human_resolution(runtime, run, &exit)?;
        }
        return Ok(exit);
    }
    // Another native question is a delivery wait, not a patrol failure.
    if state.sessions.summary(&exit.pm_session_id).await.ok()
        .and_then(|summary| summary.interaction_summary)
        .is_some_and(|summary| summary.requests.iter().any(|pending| pending.request_id != exit.request_id)) {
        return Ok(exit);
    }
    let options = exit_options(&exit.kind).into_iter().map(|(id, label)| genehub_proto::PermissionOption {
        id, label, kind: genehub_proto::PermissionOptionKind::AllowOnce,
    }).collect();
    let budget_contract = if exit.kind == "c" || (exit.kind == "a" && exit.budget.is_none()) || (exit.kind == "b" && exit.scope.is_none()) {
        "旧方案缺少明确的请求次数/时间上限或目标变更，已失效。答复只关闭旧问题，不增加预算、不改变目标；PM 需重新提出具体方案。\n".into()
    } else { match exit.budget.as_ref() {
        Some(proposal) => {
            let observed = super::request::snapshot(runtime, run, super::now_ms())?;
            format!("LLM 请求：已用 {} 次，当前上限 {} 次；申请总上限 {} 次。\n有效处理时间：已用 {}，当前上限 {}；申请总上限 {}。\n该批准只适用于以上总上限，不保证完成交付。\n",
                observed.observed_llm_rounds, observed.budget.max_llm_rounds, proposal.max_llm_rounds,
                display_duration(observed.execution_ms.div_ceil(1000)), display_duration(observed.budget.deadline_ms / 1000), display_duration(proposal.deadline_seconds))
        }
        None => exit.scope.as_ref().map(|proposal| format!("拟调整目标：{}\n具体变更：{}\n", proposal.goal, proposal.changes)).unwrap_or_default(),
    }};
    let title = match exit.kind.as_str() {
        "a" => "调整此需求的预算", "b" => "确认目标调整", "e" => "需要你处理安装或登录",
        "f" => "请验收交付结果", _ => "需要处理执行问题",
    };
    let request = genehub_proto::PermissionRequest {
        id: exit.request_id.clone(), kind: genehub_proto::PermissionRequestKind::Question,
        title: title.into(),
        detail: Some(format!("{budget_contract}申请原因与剩余工作：{}\n答复后由项目经理落实下一步。", exit.reason)),
        tool_call_id: None, options, questions: None,
    };
    if let Err(error) = state.sessions.request_workflow_question(&exit.pm_session_id, request).await {
        if created { tracing::warn!(run = %run.id, %error, "Workflow Human exit persisted but question delivery will retry"); }
        return Err(error);
    }
    Ok(exit)
}

fn archive_human_resolution(runtime: &super::RuntimeStore, run: &super::RunRecord, exit: &HumanExit) -> Result<()> {
    if exit.kind == "d" {
        archive_with_result(runtime, run, &format!("human:{}:{}", exit.kind, exit.answer.as_deref().unwrap_or("unknown")))?;
    }
    Ok(())
}

async fn apply_answer_action(state: &super::Shared, runtime: &super::RuntimeStore,
    run: &super::RunRecord, exit: &HumanExit) -> Result<()> {
    if matches!(exit.answer.as_deref(), Some("cancel" | "abandon")) {
        let current = super::load_run(runtime, &run.id)?;
        let root = super::load_run(runtime, super::request::group_id(&current))?;
        // A deliberate user resume already acknowledges the earlier stop.
        // Re-reading that old card must not cancel the reopened goal again.
        if root.request.as_ref().is_some_and(|link| link.resume_message_id.is_some()
            && !super::request::cancelled(&root) && exit.created_at_ms <= link.cancelled_at_ms) {
            return Ok(());
        }
        super::control::cancel(state, &current.workspace_id, &current.id, current.revision, false).await?;
    }
    if exit.kind == "f" && exit.answer.as_deref() == Some("pass") {
        super::control::complete_human_acceptance(runtime, &run.id)?;
    }
    if let Some(answer) = exit.answer.as_deref() {
        if !matches!(answer, "cancel" | "abandon" | "pass" | "cancelled" | "interrupted") {
            let _run = super::lock_run(runtime, &run.id)?;
            let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
            let mut current = super::load_run(runtime, &run.id)?;
            let id = format!("flow-human-answer-{}", exit.request_id);
            if current.supervision.notices.iter().all(|notice| notice.id != id) {
                current.supervision.notices.push(super::supervision::Notice {
                    id,
                    text: format!("Workflow Human 已回答 {}：{}。{} Run {} 仍需 PM 按原需求落实下一步；已批准预算不得重复追加，也不得因答复重新启动同一故障的复查。请先读取 workflow get/check/journal。",
                        exit.kind, answer,
                        exit.effect_error.as_ref().map(|error| format!("方案未生效：{error}。请核对当前预算并提出新的具体方案。"))
                            .unwrap_or_else(|| if exit.kind == "a" && answer == "approve" { "已按卡片明确总上限记账。".into() } else { String::new() }), run.id),
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
        bail!("recovery archive is not a bounded regular file: {}", path.display());
    }
    let bytes = fs::read(path)?;
    if bytes.len() > ARCHIVE_LIMIT { bail!("recovery archive grew during read"); }
    Ok(bytes)
}

fn contains_run(bytes: &[u8], run_id: &str) -> bool {
    for line in bytes.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
        if serde_json::from_slice::<Summary>(line).is_ok_and(|summary| summary.run_id == run_id) {
            return true;
        }
    }
    false
}

#[cfg(test)]
pub(super) fn latest(runtime: &super::RuntimeStore) -> Result<Vec<Summary>> {
    latest_in(&runtime.executor_directory(Path::new(""), false)?)
}

#[cfg(test)]
fn latest_in(dir: &Path) -> Result<Vec<Summary>> {
    let mut records = Vec::new();
    for filename in ["recoveries.1.jsonl", "recoveries.jsonl"] {
        for line in read_archive(&dir.join(filename))?.split(|byte| *byte == b'\n').filter(|line| !line.is_empty()) {
            if let Ok(summary) = serde_json::from_slice::<Summary>(line) {
                records.push(summary);
            }
        }
    }
    Ok(records.into_iter().rev().take(20).collect())
}

/// Persist once after the terminal Run snapshot. A replay sees the same Run
/// in either archive file and cannot duplicate its summary.
pub(super) fn archive_terminal(runtime: &super::RuntimeStore, run: &super::RunRecord) -> Result<()> {
    if run.handles.is_empty() || !matches!(run.status(), "completed" | "cancelled") {
        return Ok(());
    }
    archive_with_result(runtime, run, &run.status())
}

fn archive_with_result(runtime: &super::RuntimeStore, run: &super::RunRecord, result: &str) -> Result<()> {
    if run.handles.is_empty() { return Ok(()); }
    let scoped = super::RuntimeStore::for_package(&runtime.owner_identity, &run.workspace_id,
        &runtime.project_root, &run.package_id)?;
    let lock_id = format!("recovery-archive-{}", &super::hex_digest(run.package_id.as_bytes())[..32]);
    let _guard = super::lock_run(&scoped, &lock_id)?;
    let dir = scoped.executor_directory(Path::new(""), true)?;
    let handle = &run.handles[0];
    let target = super::load_run(&scoped, &handle.run_id)?;
    let cause = run.nodes.values().filter_map(|node| node.reason.as_deref())
        .collect::<Vec<_>>().join("; ");
    // A custom recovery can name its repair node anything. Preserve bounded
    // submitted evidence with its node and key instead of guessing meaning
    // from an id; the archive is context, never an instruction source.
    let repair = recovery_evidence(run);
    let after_digest = super::dispatch_candidate(&runtime.project_root, &scoped)
        .ok().map(|(candidate, _)| candidate.digest);
    let summary = Summary {
        run_id: run.id.clone(), handled_run_id: handle.run_id.clone(),
        at_ms: run.updated_at_ms, symptom: handle.reason.chars().take(1024).collect(),
        root_cause: cause.chars().take(2048).collect(),
        repair: repair.chars().take(2048).collect(),
        before_digest: target.dcg_digest, after_digest,
        result: result.into(), journal_run_id: run.id.clone(), journal_seq: run.journal_seq,
    };
    append_summary(&dir, &summary)
}

fn recovery_evidence(run: &super::RunRecord) -> String {
    run.nodes.iter().flat_map(|(id, node)| node.evidence.iter()
        .map(move |(key, value)| format!("{id}.{key}={value}")))
        .collect::<Vec<_>>().join("; ")
}

fn append_summary(dir: &Path, summary: &Summary) -> Result<()> {
    let current_path = dir.join("recoveries.jsonl");
    let old_path = dir.join("recoveries.1.jsonl");
    let mut current = read_archive(&current_path)?;
    let old = read_archive(&old_path)?;
    if contains_run(&current, &summary.run_id) || contains_run(&old, &summary.run_id) { return Ok(()); }
    let mut line = serde_json::to_vec(summary)?;
    line.push(b'\n');
    if line.len() > ARCHIVE_LIMIT { bail!("recovery summary exceeds archive limit"); }
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
        Summary { run_id: id.into(), handled_run_id: "business".into(), at_ms: 1,
            symptom, root_cause: String::new(), repair: String::new(),
            before_digest: "sha256:before".into(), after_digest: None,
            result: "completed".into(), journal_run_id: id.into(), journal_seq: 2 }
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
        assert_eq!(latest.iter().map(|item| item.run_id.as_str()).collect::<Vec<_>>(), ["r2", "r1"]);
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
        let mut run: super::super::RunRecord = serde_json::from_value(serde_json::json!({
            "id": "wr_custom", "workspaceId": "workspace", "parentSessionId": "s_pm",
            "workflowId": "custom-recovery", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "recover", "status": "completed", "retiredAtMs": 2, "revision": 1,
            "definition": {"schema": "genehub.workflow.definition.v1", "id": "custom-recovery", "version": 1, "nodes": []},
            "roles": {}, "nodes": {"fix-process": {"uses": "agent.session", "status": "completed", "retiredAtMs": 2, "evidence": {"changes": "activated"}}},
            "leases": {}, "createdAtMs": 1, "updatedAtMs": 2
        })).unwrap();
        assert_eq!(recovery_evidence(&run), "fix-process.changes=activated");
        run.nodes.clear();
        assert!(recovery_evidence(&run).is_empty());
    }

    #[test]
    fn human_exit_classifier_covers_budget_route_failure_and_acceptance() {
        let mut run: super::super::RunRecord = serde_json::from_value(serde_json::json!({
            "id": "wr_root", "workspaceId": "workspace", "parentSessionId": "s_pm",
            "workflowId": "direct", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "deliver", "status": "blocked", "retiredAtMs": 2, "revision": 1,
            "definition": {"schema": "genehub.workflow.definition.v1", "id": "direct", "version": 1, "nodes": []},
            "roles": {}, "nodes": {}, "leases": {}, "createdAtMs": 1, "updatedAtMs": 2,
            "stop": {"target": "blocked", "reason": "budget display may change", "causeCode": "requestBudget"}
        })).unwrap();
        run.updated_at_ms = super::super::now_ms();
        assert_eq!(classify_human_exit(&run), None); // PM has the first 30 minutes.
        run.updated_at_ms -= (DEFAULT_PM_ANSWER_SECONDS as i64 * 1000) + 1;
        assert_eq!(classify_human_exit(&run), Some("d"));
        run.stop.as_mut().unwrap().reason = "new route message".into();
        run.stop.as_mut().unwrap().cause_code = "routeUnavailable".into();
        assert_eq!(classify_human_exit(&run), Some("d"));
        run.handles.push(Handle { run_id: "wr_business".into(), trigger_seq: 1, reason: "failed".into() });
        run.stop.as_mut().unwrap().reason = "new recovery message".into();
        run.stop.as_mut().unwrap().cause_code = "recoveryBudget".into();
        assert_eq!(classify_human_exit(&run), Some("d"));
        run.stop.as_mut().unwrap().reason = "execution failed".into();
        run.stop.as_mut().unwrap().cause_code = "executionException".into();
        assert_eq!(classify_human_exit(&run), Some("d"));
    }
}

pub(super) fn builtin_bundle() -> Result<super::Bundle> {
    let source = include_str!("builtin-recovery.yaml");
    let definition: super::WorkflowDefinition = serde_yaml::from_str(source)?;
    super::validate_definition(&definition)?;
    validate_contract(&definition)?;
    let mut roles = std::collections::BTreeMap::new();
    for (id, prompt) in [
        ("recovery-reviewer", "只读复查原用户需求、被处理 Run、节点结果、日志和副作用。读取 workflow get/check/journal，核对 requestRunId 对应目标与最新约束。原目标缺失时报告不确定。业务与复查共享请求预算，不追加额度。给出诊断依据、已完成事实、风险、建议动作及验收标准，以 completed outcome 和 report 证据提交本次报告；报告无需等待 PM 固定选项作答。报告只提供建议，不授权修改预算、取消需求、交付或激活配置。PM 用受控接口决定同 Session 续接、建立后继、真实 Human 待办或确认交付。已关闭图不可续接。不要重做外部副作用，不把报告完成或消息 handled 当作用户目标交付。"),
    ] {
        roles.insert(id.to_string(), super::RoleSnapshot {
            schema: super::ROLE_SCHEMA.into(), id: id.into(), capability: None,
            tags: vec![crate::agent_routing::TAG_PRO.into()], agent_id: None,
            model_id: None, mode_id: None, runtime_values: Default::default(),
            user_interaction: genehub_proto::SessionUserInteraction::ReadOnly,
            prompt: String::new(), prompt_text: prompt.into(),
        });
    }
    Ok(super::Bundle {
        digest: format!("sha256:{:x}", sha2::Sha256::digest(source.as_bytes())),
        definition, roles, source_files: Default::default(),
    })
}

/// Recovery is an ordinary report-producing structured program. Authority to
/// act on its findings remains in the existing PM / Human control interfaces.
pub(super) fn validate_contract(definition: &super::WorkflowDefinition) -> Result<()> {
    if definition.structure.is_none() {
        bail!("recovery flow requires a v2 structured report; migrate its declared control flow before activation");
    }
    if !definition.nodes.iter().any(|node| node.uses == "agent.session") {
        bail!("recovery flow must contain an agent.session producing diagnostic evidence");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Handle {
    pub run_id: String,
    pub trigger_seq: u64,
    pub reason: String,
}

pub(super) const DEFAULT_PM_ANSWER_SECONDS: u64 = 1800;
pub(super) const MAX_PM_ANSWER_SECONDS: u64 = 86400;
