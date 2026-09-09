//! Durable stop decisions and mechanical reconciliation. This loop never calls
//! an LLM. A stop remains nonterminal until session and lease cleanup succeeds.

use super::*;
use genehub_proto::{SessionStatus, WorkflowNodeOutcome};

pub(crate) async fn summarize_sessions(state: &Shared, sessions: &mut [SessionSummary]) {
    let executing_runs = state.sessions.executing_workflow_runs().await;
    let workspace_ids = sessions
        .iter()
        .filter(|session| session.managed.is_none())
        .map(|session| session.workspace_id.clone())
        .collect::<BTreeSet<_>>();
    for workspace_id in workspace_ids {
        let Ok(workspace) = state.workspaces.get(&workspace_id).await else {
            continue;
        };
        let runs = RuntimeStore::new(&state.paths.root, &workspace_id, &workspace.root)
            .and_then(|runtime| all_runs(&runtime));
        for session in sessions
            .iter_mut()
            .filter(|session| session.workspace_id == workspace_id && session.managed.is_none())
        {
            let mut summary = genehub_proto::SessionWorkSummary {
                executing: Some(0),
                checked_at_ms: now_ms(),
                ..Default::default()
            };
            match &runs {
                Ok(runs) => {
                    let mut grouped = BTreeMap::<&str, Vec<&RunRecord>>::new();
                    for run in runs
                        .iter()
                        .filter(|run| run.parent_session_id == session.id)
                    {
                        grouped.entry(request::group_id(run)).or_default().push(run);
                    }
                    let mut owned = grouped
                        .values()
                        .filter_map(|group| {
                            group.iter().copied().max_by_key(|run| {
                                (
                                    matches!(
                                        run.status.as_str(),
                                        "running" | "stopping" | "cancelling"
                                    ),
                                    run.created_at_ms,
                                )
                            })
                        })
                        .collect::<Vec<_>>();
                    if owned.is_empty() {
                        continue;
                    }
                    summary.executing = Some(
                        owned.iter().filter(|run| executing_runs.contains(&run.id)).count() as u32,
                    );
                    for run in &owned {
                        match run.status.as_str() {
                            "running" => summary.running += 1,
                            "stopping" | "cancelling" => summary.stopping += 1,
                            "blocked" | "failed" => summary.blocked += 1,
                            _ => {}
                        }
                    }
                    // Ongoing/blocked work stays ahead of settled history.
                    owned.sort_by_key(|run| {
                        (
                            matches!(run.status.as_str(), "completed" | "cancelled"),
                            std::cmp::Reverse(run.updated_at_ms),
                        )
                    });
                    summary.more = owned.len().saturating_sub(16) as u32;
                    summary.tasks = owned
                        .into_iter()
                        .take(16)
                        .map(|run| genehub_proto::WorkflowTaskSummary {
                            executing: Some(executing_runs.contains(&run.id)),
                            waiting: (run.status == "running"
                                && !run.supervision.waiting_requests.is_empty())
                            .then(|| {
                                run.supervision
                                    .waiting_requests
                                    .iter()
                                    .take(16)
                                    .cloned()
                                    .collect()
                            }),
                            request_run_id: Some(request::group_id(run).into()),
                            report_pending: Some(grouped.get(request::group_id(run)).is_some_and(
                                |group| {
                                    group.iter().any(|run| {
                                        run.supervision.notices.iter().any(|notice| !notice.handled)
                                    })
                                },
                            )),
                            run_id: run.id.clone(),
                            task_id: run.task_id.clone(),
                            workflow_id: run.workflow_id.clone(),
                            status: run.status.clone(),
                            revision: run.revision,
                            active_nodes: run
                                .nodes
                                .iter()
                                .filter(|(_, node)| node.status == "running")
                                .map(|(id, _)| id.clone())
                                .collect(),
                            executor_session_id: run.executor_session_id.clone(),
                            reason: run
                                .stop
                                .as_ref()
                                .map(|stop| stop.reason.chars().take(512).collect())
                                .or_else(|| {
                                    (run.status == "running" && run.supervision.waiting)
                                        .then(|| "工作节点正在等待用户或上级 Agent 处理。".into())
                                }),
                            cleanup_error: run.stop.as_ref().and_then(|stop| {
                                stop.cleanup_error
                                    .as_ref()
                                    .map(|error| error.chars().take(512).collect())
                            }),
                            updated_at_ms: run.updated_at_ms,
                        })
                        .collect();
                }
                Err(error) => {
                    summary.error = Some(
                        format!("任务状态待核对：{error:#}")
                            .chars()
                            .take(512)
                            .collect(),
                    )
                }
            }
            session.work_summary = Some(summary);
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StopRequest {
    pub target: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_error: Option<String>,
}

pub(super) fn outcome_event(outcome: WorkflowNodeOutcome) -> &'static str {
    match outcome {
        WorkflowNodeOutcome::Completed => "completed",
        WorkflowNodeOutcome::ChangesRequested => "changesRequested",
        WorkflowNodeOutcome::Failed => "failed",
        WorkflowNodeOutcome::Blocked => "blocked",
    }
}

pub(super) fn validate_negative_result(
    reason: Option<&str>,
    evidence: &BTreeMap<String, String>,
) -> Result<()> {
    let reason = reason.map(str::trim).unwrap_or_default();
    if reason.is_empty() || reason.len() > 4096 {
        bail!("negative node outcome requires a reason of 1..4096 bytes");
    }
    if evidence.len() > MAX_NODES
        || evidence.iter().any(|(key, value)| {
            key.is_empty() || key.len() > 128 || value.trim().is_empty() || value.len() > 16 * 1024
        })
    {
        bail!("negative node evidence exceeds the bounded result contract");
    }
    Ok(())
}

pub(super) fn request_stop(run: &mut RunRecord, target: &str, reason: String) {
    run.status = if target == "cancelled" {
        "cancelling"
    } else {
        "stopping"
    }
    .into();
    run.stop = Some(StopRequest {
        target: target.into(),
        reason,
        cleanup_error: None,
    });
}

/// Starting a saved assignment and recording cancellation share the Run lock.
/// A delayed launch cannot resurrect a Run after its stop decision was saved.
pub(crate) async fn start_assigned(
    state: &Shared,
    workspace_id: &str,
    run_id: &str,
    session: &SessionSummary,
    message: String,
) -> Result<()> {
    let workspace = state.workspaces.get(workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let run = {
        let _guard = lock_run(&runtime, run_id)?;
        load_run(&runtime, run_id)?
    };
    request::ensure_open(&runtime, &run)?;
    if run.status != "running" {
        return Ok(());
    }
    if !run.nodes.values().any(|node| {
        node.status == "running" && node.session_id.as_deref() == Some(session.id.as_str())
    }) {
        bail!("Worker assignment no longer belongs to an active node");
    }
    state
        .sessions
        .send(
            &session.id,
            message,
            Vec::new(),
            &state.providers().await,
            None,
            None,
        )
        .await
        .map(|_| ())
}

pub(crate) async fn cancel(
    state: &Shared,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    let workspace = state.workspaces.get(workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let _guard = lock_run(&runtime, run_id)?;
    let run = load_run(&runtime, run_id)?;
    let _request = request::request_lock(&runtime, request::group_id(&run))?;
    if run.workspace_id != workspace_id {
        bail!("Workflow Run 不属于请求的 Workspace");
    }
    let mut root = load_run(&runtime, request::group_id(&run))?;
    if root
        .request
        .as_ref()
        .is_some_and(|request| request.cancelled)
    {
        return Ok(run_status(&run));
    }
    if run.revision != expected_revision {
        bail!("Workflow revision 冲突：先重新读取 workflow get");
    }
    let group = all_runs(&runtime)?
        .into_iter()
        .filter(|other| request::group_id(other) == root.id)
        .collect::<Vec<_>>();
    if group
        .iter()
        .all(|run| matches!(run.status.as_str(), "completed" | "cancelled"))
    {
        bail!("该任务的执行已全部结束");
    }
    let mut link = root.request.take().unwrap_or_else(|| request::RequestLink {
        root_run_id: root.id.clone(),
        original_message_id: format!("legacy:{}", root.id),
        ..Default::default()
    });
    link.cancelled = true;
    link.cancelled_at_ms = now_ms();
    root.request = Some(link);
    root.revision += 1;
    save_run(&runtime, &root)?; // The request fence survives a partial cascade.
    for previous in group {
        let mut current = load_run(&runtime, &previous.id)?;
        if matches!(current.status.as_str(), "completed" | "cancelled") {
            continue;
        }
        request_stop(
            &mut current,
            "cancelled",
            "用户终止该请求及全部关联执行".into(),
        );
        current.revision += 1;
        current.updated_at_ms = now_ms();
        save_run(&runtime, &current)?;
    }
    Ok(run_status(&load_run(&runtime, run_id)?))
}

static RECONCILING: LazyLock<Mutex<BTreeSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));
struct ReconcileJob(PathBuf);
impl Drop for ReconcileJob {
    fn drop(&mut self) {
        if let Ok(mut jobs) = RECONCILING.lock() {
            jobs.remove(&self.0);
        }
    }
}

pub(crate) async fn maintain(state: &Shared) {
    // Maintenance only needs registered identities. The presentation list
    // verifies every AgentSpace on disk and would block the guest on each tick.
    for summary in state.workspaces.catalog().await.workspaces {
        let Ok(workspace) = state.workspaces.get(&summary.local_workspace_id).await else {
            continue;
        };
        let runtime = match RuntimeStore::new(&state.paths.root, &workspace.id, &workspace.root) {
            Ok(runtime) => runtime,
            Err(error) => {
                tracing::warn!(%error, "workflow runtime unavailable");
                continue;
            }
        };
        let runs = match all_runs(&runtime) {
            Ok(runs) => runs,
            Err(error) => {
                tracing::warn!(%error, "workflow index needs reconciliation");
                continue;
            }
        };
        let cancelled = runs
            .iter()
            .filter(|run| {
                run.request
                    .as_ref()
                    .is_some_and(|request| request.cancelled)
            })
            .map(|run| run.id.clone())
            .collect::<BTreeSet<_>>();
        for run in runs {
            let unfinished = (cancelled.contains(request::group_id(&run))
                && !matches!(run.status.as_str(), "completed" | "cancelled"))
                || matches!(run.status.as_str(), "running" | "stopping" | "cancelling")
                || run.supervision.notices.iter().any(|notice| !notice.handled)
                || run.supervision.diagnostics.iter().any(|diagnostic| {
                    matches!(
                        diagnostic.state.as_str(),
                        "reserved" | "launching" | "running"
                    )
                });
            if !unfinished {
                continue;
            }
            let key = runtime.root.join(&run.id);
            let inserted = RECONCILING
                .lock()
                .map(|mut jobs| jobs.len() < 64 && jobs.insert(key.clone()))
                .unwrap_or(false);
            if !inserted {
                continue;
            }
            let job = ReconcileJob(key);
            let state = state.clone();
            let runtime = runtime.clone();
            let owner = state.clone();
            state.workflow_tasks.spawn(async move {
                let _job = job;
                let result: Result<()> = async {
                    reconcile(&owner, &runtime, &run.id).await?;
                    supervision::diagnostics(&owner, &runtime, &run.id).await?;
                    supervision::deliver_notice(&owner, &runtime, &run.id).await?;
                    Ok(())
                }.await;
                if let Err(error) = result { tracing::warn!(run = %run.id, %error, "workflow reconciliation remains pending"); }
            });
        }
    }
}

async fn reconcile(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<()> {
    let run = {
        let _guard = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        let root = load_run(runtime, request::group_id(&run))?;
        if root
            .request
            .as_ref()
            .is_some_and(|request| request.cancelled)
            && !matches!(
                run.status.as_str(),
                "completed" | "cancelled" | "cancelling"
            )
        {
            request_stop(&mut run, "cancelled", "恢复原请求的已持久化取消决定".into());
        }
        let previous_status = run.status.clone();
        if run.status == "running" {
            supervision::observe(state, runtime, &mut run).await?;
            for (node_id, node) in &run.nodes {
                if node.status != "running"
                    || now_ms() - node.assigned_at_ms.max(run.created_at_ms) < 10_000
                {
                    continue;
                }
                let Some(session_id) = &node.session_id else {
                    continue;
                };
                let summary = state.sessions.summary(session_id).await;
                if summary
                    .as_ref()
                    .is_ok_and(|session| session.status == SessionStatus::Waiting)
                {
                    continue;
                }
                if summary.is_err()
                    || (!state.sessions.has_execution(session_id).await
                        && summary.as_ref().is_ok_and(|session| {
                            matches!(
                                session.status,
                                SessionStatus::Idle | SessionStatus::Failed | SessionStatus::Closed
                            )
                        }))
                {
                    let reason =
                        format!("节点 {node_id} 的 Worker 已停止，尚未提交节点结果；交回 PM 处理");
                    request_stop(&mut run, "blocked", reason);
                    break;
                }
            }
        }
        if previous_status != run.status {
            run.revision += 1;
            run.updated_at_ms = now_ms();
        }
        save_run(runtime, &run)?;
        run
    };
    if !matches!(run.status.as_str(), "stopping" | "cancelling") {
        return Ok(());
    }
    let mut session_ids = run
        .nodes
        .values()
        .filter_map(|node| node.session_id.clone())
        .collect::<BTreeSet<_>>();
    session_ids.extend(run.executor_session_id.clone());
    session_ids.extend(
        run.supervision
            .diagnostics
            .iter()
            .map(|diagnostic| diagnostic.session_id.clone()),
    );
    let mut errors = Vec::new();
    // The durable Session fence closes the late-send/reopen race. Keep the
    // request and Run locks free while adapters and processes are being stopped.
    for session_id in session_ids {
        let result: Result<()> = async {
            if let Err(error) = state.sessions.fence_execution(&session_id).await {
                // Reservation is durable before Session creation. A request
                // cancelled in that interval has no diagnostic process to reap.
                let reserved = run.supervision.diagnostics.iter().any(|diagnostic| {
                    diagnostic.session_id == session_id && diagnostic.state == "reserved"
                });
                if reserved && error.is::<crate::session::manager::SessionMissing>() {
                    return Ok(());
                }
                return Err(error);
            }
            state.sessions.close(&session_id).await?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            errors.push(format!("{session_id}: {error:#}"));
        }
    }
    if errors.is_empty() {
        if let Err(error) = release_leases(runtime, &run).await {
            errors.push(format!("lease cleanup: {error:#}"));
        }
    }
    let _guard = lock_run(runtime, run_id)?;
    let _request = request::request_lock(runtime, request::group_id(&run))?;
    let mut current = load_run(runtime, run_id)?;
    if !matches!(current.status.as_str(), "stopping" | "cancelling") {
        return Ok(());
    }
    let stop = current
        .stop
        .clone()
        .ok_or_else(|| anyhow!("stopping Run has no durable stop decision"))?;
    if errors.is_empty() {
        for node in current.nodes.values_mut() {
            match node.status.as_str() {
                "running" => {
                    node.status = if stop.target == "cancelled" {
                        "cancelled"
                    } else {
                        "blocked"
                    }
                    .into()
                }
                "pending" => node.status = "unreached".into(),
                _ => {}
            }
        }
        current.status = stop.target;
        current.leases.clear();
        for diagnostic in &mut current.supervision.diagnostics {
            if matches!(
                diagnostic.state.as_str(),
                "reserved" | "launching" | "running"
            ) {
                diagnostic.state = "cancelled".into();
            }
        }
        current.stop.as_mut().expect("stop decision").cleanup_error = None;
        if let Some(executor) = current.executor_session_id.clone() {
            let message = flow_message(
                &current,
                &format!("run.{}", current.status),
                None,
                &executor,
                &current.parent_session_id,
                Some(current.revision),
                serde_json::json!({"status": current.status, "reason": stop.reason}),
            )?;
            push_flow_message(&mut current, message);
        }
    } else {
        let error = Some(errors.join("; ").chars().take(4096).collect());
        if current.stop.as_ref().expect("stop decision").cleanup_error == error {
            return Ok(());
        }
        current.stop.as_mut().expect("stop decision").cleanup_error = error;
    }
    current.revision += 1;
    current.updated_at_ms = now_ms();
    save_run(runtime, &current)
}

pub(crate) async fn validate_input_target(
    state: &Shared,
    session_id: &str,
    run_id: &str,
) -> Result<()> {
    let session = state.sessions.summary(session_id).await?;
    let workspace = state.workspaces.get(&session.workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, &session.workspace_id, &workspace.root)?;
    let run = load_run(&runtime, run_id)?;
    if run.parent_session_id != session_id {
        bail!("the task belongs to a different PM session");
    }
    Ok(())
}
