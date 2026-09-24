//! Platform ceilings for a package-selected recovery flow.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::{fs, io::ErrorKind, path::Path};

const ARCHIVE_LIMIT: usize = 1024 * 1024;
pub(super) const MAX_RECOVERY_RUNS: u32 = 10;
pub(super) const MAX_RECOVERY_LLM_ROUNDS: u64 = 1000;
pub(super) const MAX_RECOVERY_DEADLINE_SECONDS: u64 = 86400;

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
    if !metadata.is_file() || metadata.len() > 16 * 1024 { bail!("invalid Workflow human exit record"); }
    let exit: HumanExit = serde_json::from_slice(&fs::read(&path)?)?;
    if exit.run_id != run.id || !matches!(exit.kind.as_str(), "a" | "b" | "c" | "d" | "e" | "f") {
        bail!("Workflow human exit identity mismatch");
    }
    Ok(Some(exit))
}

fn exit_options(kind: &str) -> &'static [(&'static str, &'static str)] {
    match kind {
        "a" => &[("approve", "批准增加 1 次业务 Run、128 轮 LLM 和 1 小时"), ("reject", "拒绝，保留受阻请求")],
        "b" => &[("acceptScope", "接受缩减后的目标"), ("cancel", "取消原请求")],
        "c" => &[("approve", "批准本请求增加 1 次恢复、100 轮 LLM 和 30 分钟"), ("reject", "拒绝，转平台反馈")],
        "d" => &[("confirmFeedback", "确认并打开预填反馈"), ("keepOpen", "保留受阻请求")],
        "e" => &[("handled", "所需安装或登录已处理"), ("abandon", "放弃原请求")],
        "f" => &[("pass", "人工验收通过"), ("fail", "人工验收不通过")],
        _ => &[],
    }
}

pub(super) fn classify_human_exit(run: &super::RunRecord) -> Option<&'static str> {
    if run.status != "blocked" { return None; }
    let cause = run.stop.as_ref().map(|stop| stop.cause_code.as_str()).unwrap_or("");
    if run.handles.is_empty() {
        if matches!(cause, "requestBudget" | "routeUnavailable") {
            let answer_ms = DEFAULT_PM_ANSWER_SECONDS.saturating_mul(1000).min(i64::MAX as u64) as i64;
            return (super::now_ms().saturating_sub(run.updated_at_ms) >= answer_ms).then_some("d");
        }
        return None;
    }
    if cause == "humanAcceptance" { return Some("f"); }
    if cause == "humanScope" { return Some("b"); }
    if cause == "recoveryBudget" { return Some("c"); }
    if cause == "routeUnavailable" {
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

/// Materialize one native Human question per blocked Run. The file is the
/// durable Workflow reference; Session storage owns the actual answer card.
pub(super) async fn ensure_human_exit(
    state: &super::Shared,
    runtime: &super::RuntimeStore,
    run: &super::RunRecord,
    kind: &str,
    proposed_reason: Option<&str>,
) -> Result<HumanExit> {
    let (mut exit, created) = {
        let _run = super::lock_run(runtime, &run.id)?;
        let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
        if let Some(existing) = read_human_exit(runtime, run)? {
            if existing.kind != kind { bail!("Workflow Human exit already has a different kind"); }
            (existing, false)
        } else {
            super::require_request_writer(runtime, run)?;
            let current = super::load_run(runtime, &run.id)?;
            if current.status != "blocked" || current.revision != run.revision {
                bail!("Workflow Human exit target changed before question creation");
            }
            let session_id = super::notice_recipient(state, run).await?;
            let reason = proposed_reason.or_else(|| run.stop.as_ref().map(|stop| stop.reason.as_str()))
                .unwrap_or("execution blocked");
            let exit = HumanExit {
                run_id: run.id.clone(), request_id: format!("workflow-human-{}", run.id),
                pm_session_id: session_id, kind: kind.into(),
                reason: reason.chars().take(4096).collect(), created_at_ms: super::now_ms(),
                answer: None,
            };
            crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
            (exit, true)
        }
    };
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
            if !exit_options(&exit.kind).iter().any(|(id, _)| *id == selected) {
                bail!("Workflow Human selected an unknown option");
            }
            {
                let _run = super::lock_run(runtime, &run.id)?;
                let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
                if selected == "approve" && matches!(exit.kind.as_str(), "a" | "c") {
                    super::request::apply_human_budget(runtime, super::request::group_id(run), &exit.request_id, &exit.kind)?;
                }
                exit.answer = Some(selected);
                crate::config::save_private(&exit_path(runtime, run, true)?, &serde_json::to_vec(&exit)?)?;
            }
            apply_answer_action(state, runtime, run, &exit).await?;
            archive_human_resolution(runtime, run, &exit)?;
        }
        return Ok(exit);
    }
    let options = exit_options(&exit.kind).iter().map(|(id, label)| genehub_proto::PermissionOption {
        id: (*id).into(), label: (*label).into(), kind: genehub_proto::PermissionOptionKind::AllowOnce,
    }).collect();
    let request = genehub_proto::PermissionRequest {
        id: exit.request_id.clone(), kind: genehub_proto::PermissionRequestKind::Question,
        title: format!("Workflow 请求需要人工决定（出口 {}）", exit.kind),
        detail: Some(format!("Run {}：{}。答复会持久记录，相关动作由内核执行或通知 PM 继续。", run.id, exit.reason)),
        tool_call_id: None, options, questions: None,
    };
    if let Err(error) = state.sessions.request_workflow_question(&exit.pm_session_id, request).await {
        if created { tracing::warn!(run = %run.id, %error, "Workflow Human exit persisted but question delivery will retry"); }
        return Err(error);
    }
    Ok(exit)
}

fn archive_human_resolution(runtime: &super::RuntimeStore, run: &super::RunRecord, exit: &HumanExit) -> Result<()> {
    if exit.kind == "d" || (exit.kind == "c" && exit.answer.as_deref() == Some("reject")) {
        archive_with_result(runtime, run, &format!("human:{}:{}", exit.kind, exit.answer.as_deref().unwrap_or("unknown")))?;
    }
    Ok(())
}

async fn apply_answer_action(state: &super::Shared, runtime: &super::RuntimeStore,
    run: &super::RunRecord, exit: &HumanExit) -> Result<()> {
    if matches!(exit.answer.as_deref(), Some("cancel" | "abandon")) {
        let current = super::load_run(runtime, &run.id)?;
        super::control::cancel(state, &current.workspace_id, &current.id, current.revision, false).await?;
    }
    if exit.kind == "f" && exit.answer.as_deref() == Some("pass") {
        super::control::complete_human_acceptance(runtime, &run.id)?;
    }
    if let Some(answer) = exit.answer.as_deref() {
        if !matches!(answer, "cancel" | "abandon" | "pass" | "confirmFeedback" | "keepOpen") {
            let _run = super::lock_run(runtime, &run.id)?;
            let _request = super::request::request_lock(runtime, super::request::group_id(run))?;
            let mut current = super::load_run(runtime, &run.id)?;
            let id = format!("flow-human-answer-{}", run.id);
            if current.supervision.notices.iter().all(|notice| notice.id != id) {
                current.supervision.notices.push(super::supervision::Notice {
                    id,
                    text: format!("Workflow Human 已回答出口 {}：{}。Run {} 仍需 PM 核对请求目标、现有预算与受控后继；请先读取 workflow get/check/journal。", exit.kind, answer, run.id),
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

pub(super) fn latest(runtime: &super::RuntimeStore) -> Result<Vec<Summary>> {
    let dir = runtime.executor_directory(Path::new(""), false)?;
    latest_in(&dir)
}

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
    if run.handles.is_empty() || !matches!(run.status.as_str(), "completed" | "cancelled") {
        return Ok(());
    }
    archive_with_result(runtime, run, &run.status)
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
    let repair = run.nodes.iter().filter(|(id, _)| id.contains("repair"))
        .flat_map(|(_, node)| node.evidence.values()).map(String::as_str)
        .collect::<Vec<_>>().join("; ");
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
    fn human_exit_classifier_covers_budget_route_failure_and_acceptance() {
        let mut run: super::super::RunRecord = serde_json::from_value(serde_json::json!({
            "id": "wr_root", "workspaceId": "workspace", "parentSessionId": "s_pm",
            "workflowId": "direct", "bundleDigest": "sha256:test", "taskId": "task",
            "taskPrompt": "deliver", "status": "blocked", "revision": 1,
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
        assert_eq!(classify_human_exit(&run), Some("c"));
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
    for (id, prompt, evidence_only) in [
        ("recovery-reviewer", "只读复查被处理的 Run。先用 workflow journal 读取事件，再核对 Session 历史和最近的恢复总结。完成报告后，必须向控制者 PM 提出带 repair、resume、successor、human、cancel 五个选项的暂停点并等待答复；按答复用同名 outcome 提交。repair 需写明修复标准；被处理 Run 仍为 recoverable 时可用 workflow recover 原 Session 续办，已 blocked 时 resume 应由 PM 用 workflow dispatch --retry-of <被处理 Run ID> 以当前定义建立同目标后继；successor 可在激活新定义后使用同一后继命令。human/cancel 必须带具体原因，不得自行宣告请求完成。", true),
        ("recovery-manager", "依据 PM 对复查建议的决定修复 Workflow。记录修复前后 Candidate digest，执行相关验证；缺少授权时提出暂停点，不能自行激活恢复流程变更。", false),
        ("recovery-acceptor", "只读验收 WM 的修复。读取执行日志、变更和测试证据；通过时给 PM 明确的 successor 建议并提交 verdict；不通过时用 changesRequested 和原因提出返工。", true),
    ] {
        roles.insert(id.to_string(), super::RoleSnapshot {
            evidence_only,
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

/// Recovery has a smaller outcome vocabulary than a business Workflow. A
/// successful terminal publish must have passed a controlled decision first;
/// otherwise a graph can appear to finish while the user's request stalls.
pub(super) fn validate_contract(definition: &super::WorkflowDefinition) -> Result<()> {
    if definition.structure.is_some() {
        bail!("recovery flow must use a v1 graph with explicit controlled exits");
    }
    if definition.outcomes.get("human").is_none_or(|outcome| outcome.success) {
        bail!("recovery flow must declare human: {{success: false}}");
    }
    for (name, outcome) in &definition.outcomes {
        let expected = match name.as_str() {
            "repair" | "resume" | "successor" | "budget" => true,
            "cancel" | "human" => false,
            _ => bail!("recovery flow outcome {name} is not a controlled exit"),
        };
        if outcome.success != expected {
            bail!("recovery flow outcome {name} has an invalid success bit");
        }
    }
    if !definition.nodes.iter().any(|node| node.uses == "agent.session") {
        bail!("recovery flow must have an agent.session able to hand off to a Human");
    }
    let mut role_outcomes = std::collections::BTreeMap::<&str, std::collections::BTreeSet<&str>>::new();
    let mut human_exit = false;
    for node in &definition.nodes {
        if node.uses != "agent.session" { continue; }
        if node.on.is_empty() {
            bail!("recovery node {} must declare successors or explicit terminal outcomes", node.id);
        }
        human_exit |= node.on.contains_key("human");
        for (outcome, targets) in &node.on {
            if targets.is_empty() && super::outcome_success(definition, outcome) == Some(true) {
                bail!("recovery node {} cannot silently terminate successful outcome {outcome}", node.id);
            }
        }
        let role = node.inputs.role.as_deref().unwrap_or_default();
        let outcomes = node.on.keys().map(String::as_str).collect::<std::collections::BTreeSet<_>>();
        if let Some(previous) = role_outcomes.insert(role, outcomes.clone()) {
            if previous != outcomes {
                bail!("recovery role {role} has inconsistent outcomes; declare an empty successor list for an explicit terminal");
            }
        }
    }
    if !human_exit { bail!("recovery flow must expose an explicit human terminal"); }
    let mut queue = std::collections::VecDeque::from([(definition.entry.clone(), false)]);
    let mut seen = std::collections::BTreeSet::new();
    while let Some((id, controlled)) = queue.pop_front() {
        if !seen.insert((id.clone(), controlled)) { continue; }
        let node = definition.nodes.iter().find(|node| node.id == id)
            .ok_or_else(|| anyhow::anyhow!("recovery node {id} is missing"))?;
        if node.uses == "result.publish" && !controlled {
            bail!("recovery flow result.publish node {id} needs a controlled outcome before it");
        }
        for (outcome, targets) in &node.on {
            let next_controlled = controlled || matches!(outcome.as_str(), "repair" | "resume" | "successor" | "budget");
            queue.extend(targets.iter().cloned().map(|target| (target, next_controlled)));
        }
    }
    Ok(())
}

/// Check the separate request-wide allowance before creating a recovery Run.
pub(super) fn admit(runtime: &super::RuntimeStore, target: &super::RunRecord, budget: &RecoveryBudget, now: i64) -> Result<u32> {
    let usage = observe_budget(runtime, target, budget, now)?;
    if usage.runs >= usage.limits.max_runs {
        bail!("recoveryBudgetExceeded: request has used all {} recovery Runs", usage.limits.max_runs);
    }
    if usage.rounds >= usage.limits.max_llm_rounds {
        bail!("recoveryBudgetExceeded: request has exhausted recovery LLM rounds");
    }
    if usage.execution_ms >= usage.limits.deadline_seconds.saturating_mul(1000) {
        bail!("recoveryBudgetExceeded: request has exhausted recovery execution time");
    }
    Ok(usage.runs.saturating_add(1))
}

struct BudgetObservation {
    limits: RecoveryBudget,
    runs: u32,
    rounds: u64,
    execution_ms: u64,
}

fn observe_budget(runtime: &super::RuntimeStore, target: &super::RunRecord, budget: &RecoveryBudget, now: i64) -> Result<BudgetObservation> {
    budget.validate()?;
    let extra = super::request::recovery_extra(runtime, super::request::group_id(target))?;
    let limits = RecoveryBudget {
        max_runs: budget.max_runs.saturating_add(extra.max_runs).min(MAX_RECOVERY_RUNS),
        max_llm_rounds: budget.max_llm_rounds.saturating_add(extra.max_llm_rounds).min(MAX_RECOVERY_LLM_ROUNDS),
        deadline_seconds: budget.deadline_seconds.saturating_add(extra.deadline_seconds).min(MAX_RECOVERY_DEADLINE_SECONDS),
    };
    let group = super::request_runs(runtime, super::request::group_id(target))?;
    let recoveries = group.iter().filter(|run| !run.handles.is_empty()).collect::<Vec<_>>();
    Ok(BudgetObservation {
        limits,
        runs: recoveries.len().min(u32::MAX as usize) as u32,
        rounds: recoveries.iter().flat_map(|run| super::request::activities(run))
            .fold(0u64, |sum, activity| sum.saturating_add(activity.llm_rounds)),
        execution_ms: recoveries.iter().fold(0u64, |sum, run| {
            sum.saturating_add(super::request::execution_ms(run, now) as u64)
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

pub(super) fn budget_exhausted(runtime: &super::RuntimeStore, run: &super::RunRecord, now: i64) -> Result<bool> {
    let budget = run.definition.budget.clone().unwrap_or_default();
    let usage = observe_budget(runtime, run, &budget, now)?;
    Ok(usage.rounds >= usage.limits.max_llm_rounds
        || usage.execution_ms >= usage.limits.deadline_seconds.saturating_mul(1000))
}

pub(super) const DEFAULT_PM_ANSWER_SECONDS: u64 = 1800;
pub(super) const MAX_PM_ANSWER_SECONDS: u64 = 86400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryBudget {
    pub max_runs: u32,
    pub max_llm_rounds: u64,
    pub deadline_seconds: u64,
}

impl Default for RecoveryBudget {
    fn default() -> Self {
        Self { max_runs: 3, max_llm_rounds: 200, deadline_seconds: 3600 }
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
        if !(1..=MAX_RECOVERY_DEADLINE_SECONDS).contains(&self.deadline_seconds) {
            bail!("recovery budget.deadlineSeconds 必须在 1..=86400 之间");
        }
        Ok(())
    }
}
