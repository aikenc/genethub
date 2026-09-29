//! Goal ownership and PM handoff. Business acceptance stays with PM/Reviewers.
use super::*;
use genehub_proto::{WorkflowRequirementState as Phase, WorkflowRequirementStatus};

pub(super) const PM_LAUNCH_MS: i64 = 180_000;

// A failed write must still be visible in this daemon's public projection.
// Durable fault state remains in request.json whenever storage is writable.
static WRITE_FAULTS: LazyLock<Mutex<BTreeMap<PathBuf, String>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

fn fault_key(runtime: &RuntimeStore, run: &RunRecord) -> PathBuf {
    runtime
        .project_root
        .join(".genethub/components/pm/requests")
        .join(request::group_id(run))
}

pub(super) fn status(runtime: &RuntimeStore, run: &RunRecord) -> Result<WorkflowRequirementStatus> {
    if run.request.is_none() {
        return Ok(WorkflowRequirementStatus::default());
    }
    let mut status = request::read_record(runtime, request::group_id(run))?.requirement;
    if let Ok(faults) = WRITE_FAULTS.lock() {
        if let Some(error) = faults.get(&fault_key(runtime, run)) {
            status.patrol_error = Some(error.clone());
        }
    }
    Ok(status)
}

pub(super) fn terminal(runtime: &RuntimeStore, run: &RunRecord) -> Result<bool> {
    Ok(matches!(
        status(runtime, run)?.state,
        Phase::Completed | Phase::Cancelled
    ))
}

/// Called after the snapshot commit, under the existing requirement lock.
/// A later assessment never erases a prior failure or confirms the goal.
pub(super) fn sync(runtime: &RuntimeStore, run: &RunRecord) -> Result<()> {
    if run.request.is_none() {
        return Ok(());
    }
    let id = request::group_id(run);
    let mut record = request::read_record(runtime, id)?;
    let group = request_runs(runtime, id)?;
    let Some(root) = group.iter().find(|r| r.id == id) else {
        return Ok(());
    };
    let Some(latest) = group
        .iter()
        .filter(|r| r.handles.is_empty())
        .max_by_key(|r| (r.created_at_ms, &r.id))
    else {
        return Ok(());
    };
    let before = record.requirement.clone();
    if request::cancelled(root) && !root.request.as_ref().is_some_and(|l| l.cancelled_by_agent) {
        record.requirement.state = Phase::Cancelled;
    } else if matches!(
        latest.status(),
        "running" | "stopping" | "cancelling" | "recoverable"
    ) {
        if record.latest_business_run != latest.id || record.requirement.state != Phase::Completed {
            record.requirement.state = Phase::InProgress;
            record.requirement.pending_since_ms = latest.disposition_since().unwrap_or(0);
            record.requirement.completed_at_ms = None;
            record.requirement.conclusion = None;
            record.requirement.delivery_references.clear();
        }
    } else if record.requirement.state != Phase::Completed
        && group.iter().any(|r| {
            matches!(
                r.status(),
                "running" | "stopping" | "cancelling" | "recoverable"
            )
        })
    {
        record.requirement.state = Phase::InProgress;
        record.requirement.pending_since_ms = latest.disposition_since().unwrap_or(0);
    } else if record.requirement.state != Phase::Completed {
        record.requirement.state = Phase::Completing;
        if record.requirement.pending_since_ms == 0 || record.latest_business_run != latest.id {
            record.requirement.pending_since_ms = now_ms();
        }
    }
    if record.requirement.state != Phase::Completed {
        record.requirement.pm_session_id = Some(latest.parent_session_id.clone());
    }
    if before != record.requirement || record.latest_business_run != latest.id {
        record.requirement.revision = record.requirement.revision.saturating_add(1);
        record.latest_business_run = latest.id.clone();
        record.next_check_at_ms = 0;
        record.patrol_failures = 0;
        record.requirement.patrol_error = None;
        request::write_record(runtime, id, &record)?;
        if let Ok(mut faults) = WRITE_FAULTS.lock() {
            faults.remove(&fault_key(runtime, run));
        }
        tracing::info!(requirement = id, state = ?record.requirement.state,
            revision = record.requirement.revision, "user requirement state changed");
    }
    Ok(())
}

pub(crate) async fn complete_requirement(
    state: &Shared,
    workspace_id: &str,
    pm: &str,
    run_id: &str,
    expected_revision: u64,
    conclusion: &str,
    delivery_references: Vec<String>,
) -> Result<WorkflowRunStatus> {
    let conclusion = conclusion.trim();
    if conclusion.is_empty()
        || conclusion.len() > 4096
        || delivery_references.is_empty()
        || delivery_references.len() > 16
        || delivery_references
            .iter()
            .any(|r| r.trim().is_empty() || r.len() > 2048)
    {
        bail!("requirementDecisionInvalid: provide a bounded conclusion and 1..16 delivery references");
    }
    let workspace = state.workspaces.project_entry(workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let seed = load_run(&runtime, run_id)?;
    if seed.workspace_id != workspace_id || !seed.handles.is_empty() {
        bail!("requirementDecisionInvalid: identify a business Run in this project");
    }
    if super::notice_recipient(state, &seed).await? != pm {
        bail!("requirementDecisionForbidden: this PM does not own the requirement");
    }
    if !claim_request_writer(&runtime, &seed)? {
        bail!("requirement writer is owned by another daemon");
    }
    if !request_writer_verified(&runtime, &seed)? {
        control::verify_request_takeover(state, &runtime, &seed).await?;
    }
    let _run = lock_run(&runtime, run_id)?;
    let id = request::group_id(&seed);
    let _request = request::request_lock(&runtime, id)?;
    let mut record = request::read_record(&runtime, id)?;
    if record.requirement.state == Phase::Completed
        && record.requirement.pm_session_id.as_deref() == Some(pm)
        && record.requirement.conclusion.as_deref() == Some(conclusion)
        && record.requirement.delivery_references == delivery_references
    {
        let current = load_run(&runtime, run_id)?;
        release_request_writer_if_resolved(&runtime, &current)?;
        return run_status(&runtime, &current);
    }
    if record.requirement.revision != expected_revision {
        bail!("requirement revision conflict: read workflow get again");
    }
    if record.requirement.state == Phase::Cancelled {
        bail!("requirementCancelled: the user withdrew this goal");
    }
    let group = request_runs(&runtime, id)?;
    if group.iter().any(execution_unfinished) {
        bail!("requirementStillExecuting: finish execution and cleanup before confirming delivery");
    }
    for r in &group {
        if recovery::read_human_exit(&runtime, r)?.is_some_and(|e| e.answer.is_none()) {
            bail!("requirementAwaitingHuman: resolve the outstanding decision before delivery");
        }
    }
    let predecessors = business_predecessors(&group);
    if group
        .iter()
        .filter(|r| r.handles.is_empty() && !predecessors.contains(r.id.as_str()))
        .any(|r| {
            r.status() != "completed"
                && !group.iter().any(|review| {
                    review.handles.iter().any(|h| h.run_id == r.id)
                        && recovery::read_human_exit(&runtime, review)
                            .ok()
                            .flatten()
                            .is_some_and(|exit| {
                                exit.kind == "f" && exit.answer.as_deref() == Some("pass")
                            })
                })
        })
    {
        bail!("requirementStillBlocked: unresolved execution must be addressed before delivery");
    }
    record = request::read_record(&runtime, id)?;
    record.requirement.state = Phase::Completed;
    record.requirement.revision = record.requirement.revision.saturating_add(1);
    record.requirement.completed_at_ms = Some(now_ms());
    record.requirement.pm_session_id = Some(pm.into());
    record.requirement.conclusion = Some(conclusion.into());
    record.requirement.delivery_references = delivery_references;
    record.requirement.patrol_error = None;
    record.next_check_at_ms = 0;
    request::write_record(&runtime, id, &record)?;
    if let Ok(mut faults) = WRITE_FAULTS.lock() {
        faults.remove(&fault_key(&runtime, &seed));
    }
    let current = load_run(&runtime, run_id)?;
    mark_settled_if_quiescent(&runtime, &current);
    release_request_writer_if_resolved(&runtime, &current)?;
    tracing::info!(
        requirement = id,
        pm,
        "PM confirmed user requirement delivery"
    );
    run_status(&runtime, &current)
}

/// Faults are visible through workflow.get/task projections even when the
/// broken transition itself cannot advance. This is not another scheduler.
pub(super) fn record_failure(runtime: &RuntimeStore, run: &RunRecord, error: &anyhow::Error) {
    let id = request::group_id(run);
    let result = (|| -> Result<()> {
        require_request_writer(runtime, run)?;
        let _request = request::request_lock(runtime, id)?;
        let mut record = request::read_record(runtime, id)?;
        record.patrol_failures = record.patrol_failures.saturating_add(1);
        record.requirement.patrol_error = Some(format!("巡查处理失败（{} 次）：{error:#}。请在 PM 会话核对需求状态；恢复仍失败时提交平台反馈。", record.patrol_failures).chars().take(1024).collect());
        if record.patrol_failures >= 3 {
            record.next_check_at_ms = now_ms().saturating_add(60_000);
        }
        request::write_record(runtime, id, &record)
    })();
    if let Err(failure) = result {
        if let Ok(mut faults) = WRITE_FAULTS.lock() {
            // Bound the diagnostic fallback independently of task history.
            if faults.len() >= 1024 {
                if let Some(key) = faults.keys().next().cloned() {
                    faults.remove(&key);
                }
            }
            faults.insert(fault_key(runtime, run), format!("巡查无法保存处理结果：{error:#}；写入失败：{failure:#}。请在 PM 会话核对或提交平台反馈。")
                .chars().take(1024).collect());
        }
        tracing::error!(requirement = id, %error, %failure, "user requirement patrol fault cannot be persisted");
    } else if let Ok(mut faults) = WRITE_FAULTS.lock() {
        faults.remove(&fault_key(runtime, run));
    }
}

pub(super) async fn observe_wait(
    state: &Shared,
    runtime: &RuntimeStore,
    run: &RunRecord,
) -> Result<()> {
    if run.request.is_none() || !run.handles.is_empty() {
        return Ok(());
    }
    let group = request_runs(runtime, request::group_id(run))?;
    if group.iter().any(|r| {
        matches!(
            r.status(),
            "running" | "stopping" | "cancelling" | "recoverable"
        )
    }) {
        return Ok(());
    }
    for item in &group {
        if let Some(exit) = recovery::read_human_exit(runtime, item)? {
            if exit.answer.is_none() {
                // Do not defer a receipt that has already arrived. A genuine
                // wait needs only a small-record poll until its next audit.
                if state
                    .sessions
                    .workflow_question_outcome(&exit.pm_session_id, &exit.request_id)
                    .await?
                    .is_none()
                {
                    let _request = request::request_lock(runtime, request::group_id(run))?;
                    let mut record = request::read_record(runtime, request::group_id(run))?;
                    record.next_check_at_ms = now_ms().saturating_add(60_000);
                    request::write_record(runtime, request::group_id(run), &record)?;
                }
                break;
            }
        }
    }
    Ok(())
}

pub(crate) async fn wake_human(state: &Shared, session_id: &str, question_id: &str) -> Result<()> {
    let Some(run_id) = question_id.strip_prefix("workflow-human-") else {
        return Ok(());
    };
    let run_id = run_id.split("-decision-").next().unwrap_or(run_id);
    let session = state.sessions.summary(session_id).await?;
    let workspace = state.workspaces.get(&session.workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, &workspace.id, &workspace.root)?;
    let run = load_run(&runtime, run_id)?;
    if !claim_request_writer(&runtime, &run)? {
        bail!("requirement writer unavailable for Human wakeup");
    }
    if !request_writer_verified(&runtime, &run)? {
        control::verify_request_takeover(state, &runtime, &run).await?;
    }
    let _request = request::request_lock(&runtime, request::group_id(&run))?;
    let mut record = request::read_record(&runtime, request::group_id(&run))?;
    record.next_check_at_ms = 0;
    request::write_record(&runtime, request::group_id(&run), &record)
}
