//! Durable stop decisions and mechanical reconciliation. This loop never calls
//! an LLM. A stop remains nonterminal until session and lease cleanup succeeds.

use super::*;
use genehub_proto::SessionStatus;
use std::sync::atomic::{AtomicI64, Ordering};

static LAST_JOURNAL_PRUNE_DAYS: LazyLock<Mutex<BTreeMap<PathBuf, i64>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));
static LAST_PATROL_FINISHED_MS: AtomicI64 = AtomicI64::new(0);

pub(crate) fn patrol_lag_ms() -> Option<u64> {
    let last = LAST_PATROL_FINISHED_MS.load(Ordering::Relaxed);
    (last > 0).then(|| now_ms().saturating_sub(last).max(0) as u64)
}

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
        let scoped = RuntimeStore::new(&state.paths.root, &workspace_id, &workspace.root)
            .and_then(|runtime| all_runs(&runtime).map(|runs| (runtime, runs)));
        for session in sessions
            .iter_mut()
            .filter(|session| session.workspace_id == workspace_id && session.managed.is_none())
        {
            let mut summary = genehub_proto::SessionWorkSummary {
                executing: Some(0),
                checked_at_ms: now_ms(),
                ..Default::default()
            };
            match &scoped {
                Ok((runtime, runs)) => {
                    let mut grouped = BTreeMap::<&str, Vec<&RunRecord>>::new();
                    // Requests belong to the project PM component, not to a
                    // conversation. Any current PM Session can show work left
                    // behind when the dispatching conversation was removed.
                    for run in runs.iter() {
                        grouped.entry(request::group_id(run)).or_default().push(run);
                    }
                    let mut owned = grouped
                        .values()
                        .filter_map(|group| {
                            group.iter().copied().max_by_key(|run| {
                                (
                                    run.unfinished(),
                                    run.created_at_ms,
                                )
                            })
                        })
                        .collect::<Vec<_>>();
                    if owned.is_empty() {
                        continue;
                    }
                    summary.executing = Some(
                        owned
                            .iter()
                            .filter(|run| executing_runs.contains(&run.id))
                            .count() as u32,
                    );
                    for run in &owned {
                        match run.status() {
                            "running" if run.interrupted() || !run.route_wait().is_empty() => summary.blocked += 1,
                            "running" => summary.running += 1,
                            "stopping" | "cancelling" => summary.stopping += 1,
                            "blocked" | "failed" | "recoverable" => summary.blocked += 1,
                            _ => {}
                        }
                    }
                    // Ongoing/blocked work stays ahead of settled history.
                    owned.sort_by_key(|run| {
                        (
                            requirement::terminal(runtime, run).unwrap_or(false),
                            std::cmp::Reverse(run.updated_at_ms),
                        )
                    });
                    summary.more = owned.len().saturating_sub(16) as u32;
                    summary.tasks = owned
                        .into_iter()
                        .take(16)
                        .map(|run| genehub_proto::WorkflowTaskSummary {
                            observation: observability::summary(runtime, runs, run).ok(),
                            phase: Some(run.phase().into()), conditions: run.conditions(),
                            run_status: Some(run.status().to_string()),
                            recovery: Some(!run.handles.is_empty()),
                            human_exit: grouped.get(request::group_id(run)).and_then(|group| {
                                group.iter().filter_map(|item| recovery::read_human_exit(runtime, item).ok().flatten())
                                    .max_by_key(|exit| (exit.answer.is_none(), exit.created_at_ms))
                            })
                                .map(|exit| genehub_proto::WorkflowHumanExitStatus {
                                    kind: exit.kind, request_id: exit.request_id,
                                    pm_session_id: exit.pm_session_id, reason: exit.reason,
                                    created_at_ms: exit.created_at_ms, answer: exit.answer,
                                    budget: exit.budget, scope: exit.scope, effect_error: exit.effect_error,
                                }),
                            executing: Some(executing_runs.contains(&run.id)),
                            waiting: (run.status() == "running"
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
                                |group| group.iter().any(|run| supervision::report_pending(run)),
                            )),
                            run_id: run.id.clone(),
                            task_id: run.task_id.clone(),
                            workflow_id: run.workflow_id.clone(),
                            status: match requirement::status(runtime, run) {
                                Ok(_) if matches!(run.status(), "stopping" | "cancelling") => run.status().to_string(),
                                Ok(req) => match req.state {
                                    genehub_proto::WorkflowRequirementState::InProgress => "running",
                                    genehub_proto::WorkflowRequirementState::Completing => "completing",
                                    genehub_proto::WorkflowRequirementState::Completed => "completed",
                                    genehub_proto::WorkflowRequirementState::Cancelled => "cancelled",
                                }.into(),
                                Err(_) => "blocked".into(),
                            },
                            requirement: requirement::status(runtime, run).ok(),
                            revision: run.revision,
                            active_nodes: run
                                .nodes
                                .iter()
                                .filter(|(_, node)| {
                                    matches!(node.status(), "running" | "finishing")
                                })
                                .map(|(id, _)| id.clone())
                                .collect(),
                            executor_session_id: run.executor_session_id.clone(),
                            reason: run
                                .stop
                                .as_ref()
                                .map(|stop| stop.reason.chars().take(512).collect())
                                .or_else(|| {
                                    (run.status() == "running" && run.supervision.waiting)
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
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cause_code: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub actor: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_error: Option<String>,
}

/// A Worker that lost its in-memory execution can continue the same Session
/// after a daemon restart. The host does not reconstruct project files; the
/// Agent inspects the workspace and its own history. `reuse_session` keeps the
/// original Session and write lease instead of fencing them.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Recovery {
    pub node_id: String,
    pub previous_session_id: String,
    #[serde(default)]
    pub waiting_since_ms: i64,
    #[serde(default)]
    pub reuse_session: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub nodes: Vec<RecoveryNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RecoveryNode {
    pub node_id: String,
    pub session_id: String,
}

pub(super) fn recovery_targets(recovery: &Recovery) -> Vec<(String, String)> {
    if recovery.nodes.is_empty() {
        vec![(
            recovery.node_id.clone(),
            recovery.previous_session_id.clone(),
        )]
    } else {
        recovery
            .nodes
            .iter()
            .map(|node| (node.node_id.clone(), node.session_id.clone()))
            .collect()
    }
}

fn continue_message(run: &RunRecord, node: &NodeDefinition) -> String {
    format!(
        "daemon 已重启。本节点尚未提交结果。请先核对本会话历史、任务工作目录（git status、现有文件）和已完成动作，再从中断处继续同一节点；不要重做已经完成的工作，也不要另开任务。只有项目目录消失或会话无法继续时才明确失败。\n\n{}",
        super::task_message(run, node)
    )
}

fn reroute_message(
    run: &RunRecord,
    node: &NodeDefinition,
    previous_agent_id: &str,
    previous_model_id: Option<&str>,
) -> String {
    format!(
        "上一执行路由 `{}/{}` 已在本节点执行中失败，daemon 已按本角色标签和机器全局实时成本自动切换路由。本节点、Session 与写租约均未改变。请先核对本会话历史、任务工作目录（git status、现有文件）和已完成动作，再从失败处继续；不要重做已经完成的工作，也不要另开任务。\n\n{}",
        previous_agent_id,
        previous_model_id.unwrap_or("default"),
        super::task_message(run, node)
    )
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
    request_stop_with_cause(run, target, reason, "executionException");
}

pub(super) fn request_stop_with_cause(
    run: &mut RunRecord,
    target: &str,
    reason: String,
    cause_code: &str,
) {
    // Cancellation is monotonic; a later observation cannot downgrade it.
    if run.stop.as_ref().is_some_and(|stop| stop.target == "cancelled") { return; }
    run.retired_at_ms = None;
    run.stop = Some(StopRequest {
        target: target.into(),
        reason,
        cause_code: cause_code.into(),
        actor: String::new(),
        cleanup_error: None,
    });
}

/// A missing live route is a dispatch wait, not evidence that a Worker failed.
/// Keep completed predecessors and parallel Workers intact. Once there is no
/// active Worker, expose the wait as a blocked Run without aborting its graph.
pub(super) fn defer_unavailable_route(run: &mut RunRecord, targets: &[String], reason: String) {
    for id in targets {
        if let Some(node) = run.nodes.get_mut(id).filter(|node| node.status() == "pending") {
            node.reason = Some(reason.clone());
            node.route_wait.get_or_insert(facts::RouteWait { occurrence: 0, since_ms: now_ms(), reason: reason.clone() });
        }
    }
    if run.route_wait().is_empty() {
        request_stop_with_cause(run, "blocked", reason, "routeUnavailable");
        return;
    }

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
    let _guard = lock_run(&runtime, run_id)?;
    let mut run = load_run(&runtime, run_id)?;
    let _request = request::request_lock(&runtime, request::group_id(&run))?;
    request::ensure_open(&runtime, &run)?;
    if run.status() != "running" {
        return Ok(());
    }
    let deadline_reached = run
        .engine
        .as_ref()
        .and_then(|engine| workflow_engine::pending(engine).wake_at_ms)
        .is_some_and(|deadline| now_ms().max(0) as u64 >= deadline);
    let request_budget_exhausted =
        run.engine.is_some() && request::budget_exhausted(&runtime, &run, now_ms())?;
    if run.engine.is_some() && (deadline_reached || request_budget_exhausted) {
        let (reason, cause) = if request_budget_exhausted && !run.handles.is_empty() {
            ("恢复流程达到执行期限或 LLM 调用上限", "recoveryBudget")
        } else if request_budget_exhausted {
            ("用户需求达到执行期限或 LLM 调用上限", "requestBudget")
        } else {
            ("结构化流程活动达到期限", "activityDeadline")
        };
        request_stop_with_cause(
            &mut run,
            "blocked",
            reason.into(),
            cause,
        );
        run.revision += 1;
        save_run(&runtime, &run)?;
        return Ok(());
    }
    if !run.nodes.values().any(|node| {
        node.status() == "running" && node.session_id.as_deref() == Some(session.id.as_str())
    }) {
        bail!("Worker assignment no longer belongs to an active node");
    }
    if run.engine.is_some() {
        let node = run
            .nodes
            .iter()
            .find(|(_, node)| node.session_id.as_deref() == Some(session.id.as_str()))
            .map(|(id, _)| id.clone())
            .expect("assignment validated");
        if structured::accepted(&mut run, &node)? {
            run.revision += 1;
            save_run(&runtime, &run)?;
        }
        if run.status() != "running" {
            return Ok(());
        }
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
    by_agent: bool,
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
        .is_some_and(|request| request.cancelled && (by_agent || !request.cancelled_by_agent))
    {
        return run_status(&runtime, &run);
    }
    if run.revision != expected_revision {
        bail!("Workflow revision 冲突：先重新读取 workflow get");
    }
    let group = request_runs(&runtime, &root.id)?;
    if by_agent && group.iter().all(|r| matches!(r.status(), "completed" | "cancelled")) {
        return run_status(&runtime, &run);
    }
    if requirement::terminal(&runtime, &run)? {
        bail!("该用户需求已结束");
    }
    let mut link = root.request.take().unwrap_or_else(|| request::RequestLink {
        root_run_id: root.id.clone(),
        original_message_id: format!("legacy:{}", root.id),
        ..Default::default()
    });
    link.cancelled = !by_agent;
    link.cancelled_at_ms = now_ms();
    link.cancelled_by_agent = by_agent;
    root.request = Some(link);
    root.revision += 1;
    save_run(&runtime, &root)?; // The request fence survives a partial cascade.
    for previous in group {
        let mut current = load_run(&runtime, &previous.id)?;
        if let Some(exit) = recovery::read_human_exit(&runtime, &previous)? {
            state.sessions.cancel_workflow_question(&exit.pm_session_id, &exit.request_id).await?;
        }
        let retired = recovery::retire_human_exit(&runtime, &mut current, by_agent)?;
        // Retire the notices where they were actually delivered, which is not
        // necessarily the Session that dispatched the Run.
        let recipient = super::notice_recipient(state, &previous).await?;
        state
            .sessions
            .discard_workflow_inputs(&recipient, &previous.id)
            .await?;
        let pending = current.supervision.notices.iter().any(|n| !n.handled);
        for notice in &mut current.supervision.notices { notice.accepted = true; notice.handled = true; }
        if matches!(current.status(), "completed" | "cancelled") {
            if retired || pending {
                current.journal_actor = if by_agent { "pm" } else { "human" }.into();
                save_run(&runtime, &current)?;
            }
            continue;
        }
        request_stop(
            &mut current,
            "cancelled",
            if by_agent {
                "执行方终止该请求及全部关联执行".into()
            } else {
                "用户终止该请求及全部关联执行".into()
            },
        );
        current.revision += 1;
        current.updated_at_ms = now_ms();
        save_run(&runtime, &current)?;
    }
    run_status(&runtime, &load_run(&runtime, run_id)?)
}

/// Resume the pinned structured graph at one unfinished operation. This is an
/// explicit PM decision; the host does not infer idempotence from a missing
/// result or from the absence of a declared write lease.
pub(crate) async fn recover(
    state: &Shared,
    workspace_id: &str,
    run_id: &str,
    expected_revision: u64,
) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    let workspace = state.workspaces.get(workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let assignments = {
        let _guard = lock_run(&runtime, run_id)?;
        let mut run = load_run(&runtime, run_id)?;
        let _request = request::request_lock(&runtime, request::group_id(&run))?;
        request::ensure_open(&runtime, &run)?;
        if run.workspace_id != workspace_id {
            bail!("Workflow Run 不属于请求的 Workspace");
        }
        if run.revision != expected_revision {
            bail!(
                "Workflow revision 冲突：当前为 {}，请求为 {}；先重新读取 workflow get",
                run.revision,
                expected_revision
            );
        }
        if !run.program_open() || !run.interrupted() {
            bail!("Run 没有可续接的未交卷节点；已关闭程序需要新建后继");
        }
        if request::budget_exhausted(&runtime, &run, now_ms())? {
            bail!("原始请求预算已耗尽；先核对并调整共享预算");
        }
        let targets = run.nodes.iter().filter_map(|(id, node)|
            node.interruption.as_ref().map(|fault| (id.clone(), fault.clone()))).collect::<Vec<_>>();
        // Validate the entire set before persisting any continuation intent.
        let mut assignments = Vec::new();
        for (id, fault) in &targets {
            let node = &run.nodes[id];
            if node.status() != "running" || node.session_id.as_deref() != Some(&fault.session_id)
                || node.attempt != fault.attempt { bail!("恢复节点身份已改变"); }
            if let Some(lease) = run.leases.get(id) {
                let key = hex_digest(lease.resource.as_bytes());
                let directory = runtime.directory(Path::new("ref-leases"), false)?;
                let reservation = load_lease_if_present(&directory.join(format!("{key}.json")))?;
                if !reservation.is_some_and(|owner| owner.run_id == run.id && owner.resource == lease.resource) {
                    bail!("恢复节点 {id} 的写租约归属已改变，拒绝续接");
                }
            }
            match state.sessions.worker_continuation(&fault.session_id).await {
                crate::session::manager::WorkerContinuation::Ready => {},
                crate::session::manager::WorkerContinuation::ProcessAlive { .. } => bail!("旧 Worker 仍在运行，暂停续接"),
                crate::session::manager::WorkerContinuation::Unavailable { reason } => bail!("{reason}"),
            }
            let summary = state.sessions.summary(&fault.session_id).await?;
            assignments.push((summary, continue_message(&run, &runtime_node(&run, id)?)));
        }
        for (id, _) in &targets {
            let node = run.nodes.get_mut(id).expect("validated node");
            node.interruption = None;
            node.assigned_at_ms = now_ms();
        }
        run.recovery = None;
        run.revision = run.revision.saturating_add(1);
        run.updated_at_ms = now_ms();
        record_assigned_messages(&mut run, &assignments)?;
        save_run(&runtime, &run)?;
        assignments
    };
    for (session, message) in assignments {
        start_assigned(state, workspace_id, run_id, &session, message).await?;
    }
    run_status(&runtime, &load_run(&runtime, run_id)?)
}

pub(crate) async fn budget(
    state: &Shared,
    workspace_id: &str,
    actor_session_id: Option<&str>,
    run_id: &str,
    expected_revision: u64,
    deadline_seconds: Option<u64>,
    max_llm_rounds: Option<u64>,
) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    if deadline_seconds.is_none() && max_llm_rounds.is_none() {
        bail!("workflow.budget 至少需要一个预算上限");
    }
    if deadline_seconds
        .is_some_and(|value| value == 0 || value > request::MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS)
    {
        bail!(
            "deadlineSeconds 必须在 1..={} 之间",
            request::MAX_CONFIGURED_REQUEST_DEADLINE_SECONDS
        );
    }
    if max_llm_rounds.is_some_and(|value| value == 0 || value > request::MAX_CONFIGURED_LLM_ROUNDS)
    {
        bail!(
            "maxLlmRounds 必须在 1..={} 之间",
            request::MAX_CONFIGURED_LLM_ROUNDS
        );
    }
    let workspace = state.workspaces.get(workspace_id).await?;
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let selected = load_run(&runtime, run_id)?;
    if selected.workspace_id != workspace_id {
        bail!("Workflow Run 不属于请求的 Workspace");
    }
    let root_id = request::group_id(&selected).to_string();
    // A settled requirement releases its writer. Explicit later decisions
    // reacquire and verify ownership before mutating its shared record.
    let root = load_run(&runtime, &root_id)?;
    if !claim_request_writer(&runtime, &root)? {
        bail!("Workflow 请求由另一个 daemon 执行；当前实例不能调整预算");
    }
    if !request_writer_verified(&runtime, &root)? {
        verify_request_takeover(state, &runtime, &root).await?;
    }
    let _guard = lock_run(&runtime, &root_id)?;
    let _request = request::request_lock(&runtime, &root_id)?;
    let mut root = load_run(&runtime, &root_id)?;
    let mut link = root.request.take().unwrap_or_else(|| request::RequestLink {
        root_run_id: root.id.clone(),
        original_message_id: format!("legacy:{}", root.id),
        ..Default::default()
    });
    if link.budget.revision != expected_revision {
        bail!("Workflow 预算 revision 冲突：先重新读取 workflow get");
    }
    let previous = link.budget.status();
    if let Some(value) = deadline_seconds {
        link.budget.deadline_ms = value
            .checked_mul(1000)
            .ok_or_else(|| anyhow!("deadlineSeconds 超出范围"))?;
    }
    if let Some(value) = max_llm_rounds {
        link.budget.max_llm_rounds = value;
    }
    link.budget.revision = link.budget.revision.saturating_add(1);
    let current = link.budget.status();
    root.request = Some(link);
    let sender = actor_session_id
        .unwrap_or(root.parent_session_id.as_str())
        .to_string();
    record_budget_update(&mut root, &sender, &previous, &current)?;
    // Terminal updated_at is the execution cutoff, not the time of later
    // budget decisions. The control message carries its own audit timestamp.
    if matches!(root.status(), "running" | "stopping" | "cancelling") {
        root.updated_at_ms = now_ms();
    }
    save_run(&runtime, &root)?;
    run_status(&runtime, &root)
}

static RECONCILING: LazyLock<Mutex<BTreeMap<PathBuf, i64>>> =
    LazyLock::new(|| Mutex::new(BTreeMap::new()));

/// Includes jobs waiting for a semaphore as well as jobs inside the patrol.
pub(crate) fn patrol_jobs() -> (u32, Option<u64>) {
    let Ok(jobs) = RECONCILING.lock() else { return (0, None); };
    let oldest = jobs.values().min().copied();
    (jobs.len().min(u32::MAX as usize) as u32,
        oldest.map(|started| now_ms().saturating_sub(started).max(0) as u64))
}
// Bound simultaneous reconciliation work without discarding requests beyond
// the old global 64-job cutoff. Every request remains queued for a patrol.
static RECONCILE_PERMITS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(64));
static RECOVERY_RECONCILE_PERMITS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(8));
struct ReconcileJob(PathBuf);
impl Drop for ReconcileJob {
    fn drop(&mut self) {
        if let Ok(mut jobs) = RECONCILING.lock() {
            jobs.remove(&self.0);
        }
    }
}

pub(crate) async fn maintain(state: &Shared) {
    let now = now_ms();
    let utc_day = now.div_euclid(24 * 60 * 60 * 1000);
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
        let runs = match maintenance_runs(&runtime) {
            Ok(runs) => runs,
            Err(error) => {
                tracing::warn!(%error, "workflow index needs reconciliation");
                continue;
            }
        };
        // A project first opened later in the UTC day still needs immediate
        // retention cleanup. Track the day per project instead of globally.
        let prune_logs = LAST_JOURNAL_PRUNE_DAYS
            .lock()
            .map(|days| days.get(&runtime.project_root).copied() != Some(utc_day))
            .unwrap_or(true);
        if prune_logs {
            if let Err(error) = journal::prune_project(&runtime, now) {
                tracing::warn!(%error, "workflow journal retention remains pending");
            } else {
                if let Ok(mut days) = LAST_JOURNAL_PRUNE_DAYS.lock() {
                    days.insert(runtime.project_root.clone(), utc_day);
                }
            }
        }
        let mut latest = BTreeMap::<&str, &RunRecord>::new();
        for run in &runs {
            let id = request::group_id(run);
            if latest.get(id).is_none_or(|previous| previous.created_at_ms <= run.created_at_ms) {
                latest.insert(id, run);
            }
        }
        for run in latest.values() {
            if matches!(run.status(), "completed" | "cancelled") {
                if let Err(error) = release_request_writer_if_resolved(&runtime, run) {
                    tracing::warn!(run = %run.id, %error, "workflow request writer release remains pending");
                }
            }
        }
        let cancelled = runs
            .iter()
            .filter(|run| {
                request::cancelled(run)
            })
            .map(|run| run.id.clone())
            .collect::<BTreeSet<_>>();
        for run in runs {
            let unfinished = run.unfinished()
                || (!cancelled.contains(request::group_id(&run)) && supervision::report_pending(&run));
            match claim_request_writer(&runtime, &run) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    tracing::warn!(run = %run.id, %error, "workflow request writer unavailable");
                    requirement::record_failure(&runtime, &run, &error);
                    continue;
                }
            }
            if !request_writer_verified(&runtime, &run).unwrap_or(false) {
                if let Err(error) = verify_request_takeover(state, &runtime, &run).await {
                    tracing::warn!(run = %run.id, %error, "workflow request takeover remains pending");
                    requirement::record_failure(&runtime, &run, &error);
                    continue;
                }
            }
            if !unfinished && requirement::terminal(&runtime, &run).unwrap_or(false) {
                // Repair the optimization marker after a crash between the
                // durable PM decision and settlement. Serialize with dispatch.
                if let Ok(_request) = request::request_lock(&runtime, request::group_id(&run)) {
                    if let Ok(current) = load_run(&runtime, &run.id) {
                        mark_settled_if_quiescent(&runtime, &current);
                        if let Err(error) = release_request_writer_if_resolved(&runtime, &current) {
                            requirement::record_failure(&runtime, &current, &error);
                        }
                    }
                }
                continue;
            }
            // Retain per-Run de-duplication. The request writer and operation
            // locks serialize mutations across its Run history.
            let key = runtime.root.join(&run.id);
            let inserted = RECONCILING
                .lock()
                .map(|mut jobs| match jobs.entry(key.clone()) {
                    std::collections::btree_map::Entry::Vacant(entry) => {
                        entry.insert(now_ms());
                        true
                    }
                    std::collections::btree_map::Entry::Occupied(_) => false,
                })
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
                let permits = if run.handles.is_empty() { &*RECONCILE_PERMITS } else { &*RECOVERY_RECONCILE_PERMITS };
                let Ok(_permit) = permits.acquire().await else {
                    return;
                };
                let patrol = async {
                    let execution = async {
                        finish_nodes(&owner, &runtime, &run.id).await?;
                        structured::drive(&owner, &runtime, &run.id).await?;
                        reconcile(&owner, &runtime, &run.id).await
                    }.await;
                    if let Err(error) = execution {
                        tracing::warn!(run = %run.id, %error, "workflow execution reconciliation remains pending");
                        requirement::record_failure(&runtime, &run, &error);
                    }
                    if let Err(error) = maybe_resume_route(&owner, &runtime, &run.id).await {
                        tracing::warn!(run = %run.id, %error, "workflow route resumption remains pending");
                        requirement::record_failure(&runtime, &run, &error);
                    }
                    match maybe_start_recovery(&owner, &runtime, &run.id).await {
                        Ok(true) => return,
                        Ok(false) => {}
                        Err(error) => {
                            tracing::warn!(run = %run.id, %error, "workflow recovery start remains pending");
                            requirement::record_failure(&runtime, &run, &error);
                        }
                    }
                    if let Ok(current) = load_run(&runtime, &run.id) {
                        let exit_kind = recovery::read_human_exit(&runtime, &current)
                            .ok().flatten().map(|exit| exit.kind);
                        let kind = exit_kind.as_deref().or_else(|| recovery::classify_human_exit(&current));
                        if let Some(kind) = kind {
                            if let Err(error) = recovery::ensure_human_exit(&owner, &runtime, &current, kind, None).await {
                                tracing::warn!(run = %run.id, %error, "workflow Human exit remains pending");
                                requirement::record_failure(&runtime, &run, &error);
                            }
                        }
                    }
                    if let Err(error) = supervision::deliver_notice(&owner, &runtime, &run.id).await {
                        tracing::warn!(run = %run.id, %error, "workflow PM handoff remains pending");
                        requirement::record_failure(&runtime, &run, &error);
                    }
                    if let Ok(current) = load_run(&runtime, &run.id) {
                        if let Err(error) = requirement::observe_wait(&owner, &runtime, &current).await {
                            requirement::record_failure(&runtime, &current, &error);
                        }
                        mark_settled_if_quiescent(&runtime, &current);
                        if let Err(error) = release_request_writer_if_resolved(&runtime, &current) {
                            requirement::record_failure(&runtime, &current, &error);
                        }
                    }
                };
                // Cancelling this future can discard a pack.script result after
                // its external side effect but before the Run commit. Keep the
                // per-job deadline as a visible watchdog; the declared script
                // timeout and request budget own execution termination.
                tokio::pin!(patrol);
                tokio::select! {
                    _ = &mut patrol => {},
                    _ = tokio::time::sleep(Duration::from_secs(300)) => {
                        tracing::error!(run = %run.id, "workflow patrol job exceeded 300 seconds; waiting for a durable outcome");
                        requirement::record_failure(&runtime, &run, &anyhow!("巡查超过 300 秒，仍在等待执行回执；未重放外部动作"));
                        patrol.await;
                    }
                }
            });
        }
    }
    LAST_PATROL_FINISHED_MS.store(now_ms(), Ordering::Relaxed);
}

/// Retry only assignments that never started. In particular, a completed
/// predecessor or an active sibling is never replayed after a route outage.
async fn maybe_resume_route(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<bool> {
    let (workspace_id, sessions) = {
        let _guard = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        if !matches!(run.status(), "running" | "blocked") || run.route_wait().is_empty()
            || (run.status() == "blocked" && !run.stop.as_ref().is_some_and(|stop| stop.cause_code == "routeUnavailable"))
            || recovery::read_human_exit(runtime, &run)?.is_some() {
            return Ok(false);
        }
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        request::ensure_open(runtime, &run)?;
        if request::budget_exhausted(runtime, &run, now_ms())? { return Ok(false); }
        let targets = run.route_wait();
        if run.engine.is_some() {
            if run.status() != "blocked" { return Ok(false); } // structured::drive retries a live graph
            structured::validate_snapshot(&run)?;
            for id in &targets {
                let node = runtime_node(&run, id)?;
                let role = run.roles.get(node.inputs.role.as_deref().unwrap_or_default())
                    .ok_or_else(|| anyhow!("Workflow route-wait role is missing"))?;
                if resolve_role_route(state, role, run.agent_target.as_ref()).await.is_err() { return Ok(false); }
            }
            run.legacy_program_status = run.engine.is_none().then(|| "running".into());
            run.stop = None;
            run.retain_routes(|_| false);
            for id in &targets {
                if let Some(node) = run.nodes.get_mut(id) { node.reason = None; }
            }
            run.revision = run.revision.saturating_add(1);
            run.updated_at_ms = now_ms();
            run.journal_actor = "patrol".into();
            save_run(runtime, &run)?;
            return Ok(true);
        }
        if targets.iter().any(|id| run.nodes.get(id).is_none_or(|node| node.status() != "pending")) {
            bail!("Workflow route-wait target is no longer pending");
        }
        let was_blocked = run.status() == "blocked";
        let statuses_before = run.nodes.iter().map(|(id, node)| (id.clone(), node.status().to_string()))
            .collect::<BTreeMap<_, _>>();
        run.legacy_program_status = run.engine.is_none().then(|| "running".into());
        run.stop = None;
        let leases_before = run.leases.clone();
        let sessions = match activate(state, &runtime.project_root, runtime, &mut run, targets.clone()).await {
            Ok(sessions) => sessions,
            Err(error) if is_route_unavailable(&error) => {
                let progressed = run.route_wait() != targets || run.nodes.iter().any(|(id, node)| {
                    statuses_before.get(id).map(String::as_str) != Some(node.status())
                });
                if !progressed && (was_blocked || run.nodes.values().any(|node| {
                    matches!(node.status(), "running" | "finishing")
                })) {
                    return Ok(false);
                }
                // A sibling may have finished after the route was first lost.
                // Persist the blocked projection before retrying another tick.
                let reason = format!("待派发节点路由仍不可用：{error:#}");
                defer_unavailable_route(&mut run, &targets, reason);
                run.revision = run.revision.saturating_add(1);
                run.updated_at_ms = now_ms();
                save_run(runtime, &run)?;
                return Ok(false);
            }
            Err(error) => return Err(error),
        };
        run.retain_routes(|id| !targets.contains(id));
        for id in &targets {
            if let Some(node) = run.nodes.get_mut(id) { node.reason = None; }
        }
        settle_if_terminal(&mut run);
        release_recovery_handoff_leases(runtime, &mut run).await;
        run.revision = run.revision.saturating_add(1);
        run.updated_at_ms = now_ms();
        run.journal_actor = "patrol".into();
        let persisted = (|| -> Result<()> {
            record_assigned_messages(&mut run, &sessions)?;
            save_run(runtime, &run)
        })();
        if let Err(error) = persisted {
            let leases = run.leases.iter().filter(|(id, _)| !leases_before.contains_key(*id))
                .map(|(_, lease)| lease.clone()).collect::<Vec<_>>();
            return Err(with_activation_cleanup(state, runtime, &sessions, &leases, error).await);
        }
        (run.workspace_id.clone(), sessions)
    };
    for (session, message) in sessions {
        if let Err(error) = start_assigned(state, &workspace_id, run_id, &session, message).await {
            abort_launch(state, &workspace_id, run_id).await?;
            return Err(error);
        }
    }
    Ok(true)
}

/// Acceptance is a request-level fact held by the formal Human exit.
/// This compatibility entry validates the target; it never rewrites history.
pub(super) fn complete_human_acceptance(runtime: &RuntimeStore, recovery_id: &str) -> Result<()> {
    let run = load_run(runtime, recovery_id)?;
    let target = run.handles.first().ok_or_else(|| anyhow!("not a recovery Run"))?;
    let business = load_run(runtime, &target.run_id)?;
    if business.unfinished() || run.unfinished() { bail!("Human acceptance requires completed cleanup"); }
    request::ensure_open(runtime, &business)
}

/// The patrol and read-only diagnostics consume the same current admission
/// facts. Suppression is derived, never persisted as another lifecycle.
pub(super) async fn recovery_suppression(
    state: &Shared, runtime: &RuntimeStore, run: &RunRecord,
) -> Result<Option<(&'static str, String)>> {
    if !run.handles.is_empty() { return Ok(Some(("recoveryReport", "恢复报告的处置由 PM 接手".into()))); }
    if requirement::terminal(runtime, run)? { return Ok(Some(("goalTerminal", "原需求已结束".into()))); }
    if run.phase() == "closing" { return Ok(Some(("cleanupPending", "等待原执行确认退休后才能复查".into()))); }
    if run.program_open() && !run.interrupted() && run.route_wait().is_empty() {
        return Ok(Some(("noDisposition", "当前没有待处理的执行异常".into())));
    }
    let group = request_runs(runtime, request::group_id(&run))?;
    if group.iter().find(|item| item.id == request::group_id(&run)).is_some_and(request::cancelled) {
        return Ok(Some(("requestCancelled", "原需求取消屏障已生效".into())));
    }
    if group.iter().filter(|item| item.handles.is_empty())
        .max_by_key(|item| (item.created_at_ms, &item.id)).is_none_or(|latest| latest.id != run.id)
        || group.iter().any(|r| r.id != run.id && r.unfinished()) {
        return Ok(Some(("executionPending", "请求已有更新的业务执行或仍有未收妥的其他执行".into())));
    }
    for item in &group {
        if let Some(exit) = recovery::read_human_exit(runtime, item)? {
            if exit.answer.is_none() { return Ok(Some(("humanWait", format!("等待当前需求的正式决定 {}", exit.request_id)))); }
        }
    }
    let parent = super::notice_recipient(state, &run).await?;
    // A valid PM Human wait belongs to this requirement only when the
    // current input is bound to it; an unrelated question cannot hide it.
    let (message, task_run, _) = state.sessions.current_request(&parent).await.unwrap_or_default();
    let current_group = task_run.as_deref().and_then(|id| load_run(runtime, id).ok())
        .map(|current| request::group_id(&current).to_string());
    let summary = state.sessions.summary(&parent).await;
    if summary.as_ref().is_ok_and(|s| s.input_summary.as_ref().is_some_and(|input| input.paused && input.pause_reason.as_deref() != Some("executionFailure"))) {
        return Ok(Some(("pmPaused", "PM 被用户暂停或暂停来源未知；自动巡查不能解除暂停".into())));
    }
    let belongs_here = current_group.as_deref() == Some(request::group_id(&run))
        || message.as_deref().is_some_and(|id| run.request.as_ref().is_some_and(|r| r.original_message_id == id));
    // Only the requirement-scoped Human exits above suppress its patrol.
    // A Session-wide question can belong to another input in the same batch.
    let goal = requirement::status(runtime, &run)?;
    let pending_since = run.disposition_since().unwrap_or(if goal.pending_since_ms > 0 { goal.pending_since_ms } else { run.updated_at_ms });
    let elapsed = now_ms().saturating_sub(pending_since);
    let needs_pm_window = run.status() != "blocked" || run.stop.as_ref()
        .is_some_and(|s| matches!(s.cause_code.as_str(), "requestBudget" | "routeUnavailable"));
    if needs_pm_window {
        let activity = state.sessions.execution_activity(&parent).await.ok();
        let active_here = belongs_here
            && summary.as_ref().is_ok_and(|s| s.status == SessionStatus::Running)
            && activity.is_some_and(|a| a.last_at_ms >= pending_since);
        let limit = if active_here { requirement::PM_DECISION_MS } else { requirement::PM_LAUNCH_MS };
        if elapsed < limit { return Ok(Some(("pmWindow", format!("等待 PM 处理，剩余 {} 毫秒", limit - elapsed)))); }
    }
    // Admission is tied to an execution boundary, never to a Human answer,
    // budget edit, feedback receipt, or the current journal tail.
    let reviewed = |trigger: u64| group.iter().any(|attempt| attempt.handles.iter()
        .any(|handle| handle.run_id == run.id && handle.trigger_seq >= trigger));
    let trigger = match recovery::trigger_seq(&run) {
        Some(trigger) => trigger,
        // A stop committed before boundaries were recorded gets at most one
        // automatic review; later journal growth cannot re-arm it.
        None if request::stopped(&run) && !reviewed(0) => run.journal_seq,
        None => return Ok(Some(("noBoundary", "尚无已提交的异常边界".into()))),
    };
    if reviewed(trigger) { return Ok(Some(("alreadyReviewed", format!("异常 {trigger} 已发起过自动复查；报告后等待 PM 处置")))); }
    // Recovery spends the same allowance as business execution. At exhaustion
    // PM must propose a useful concrete budget; patrol must not invent a grant.
    if request::budget_exhausted(runtime, &run, now_ms())? { return Ok(Some(("requestBudget", "原需求共享预算已耗尽".into()))); }
    if package_has_active_recovery(runtime, &run.package_id)? { return Ok(Some(("recoveryBusy", "当前包已有活动恢复执行".into()))); }
    Ok(None)
}

async fn maybe_start_recovery(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<bool> {
    let run = load_run(runtime, run_id)?;
    if recovery_suppression(state, runtime, &run).await?.is_some() { return Ok(false); }
    let parent = super::notice_recipient(state, &run).await?;
    if run.program_open() {
        let _guard = lock_run(runtime, &run.id)?;
        let mut current = load_run(runtime, &run.id)?;
        let _request = request::request_lock(runtime, request::group_id(&current))?;
        request::ensure_open(runtime, &current)?;
        if !current.interrupted() && current.route_wait().is_empty() { return Ok(false); }
        if request::budget_exhausted(runtime, &current, now_ms())? { return Ok(false); }
        request_stop_with_cause(&mut current, "blocked", "节点异常超过 PM 处理期限；关闭原图后复查".into(), "unresolvedInterruption");
        current.revision = current.revision.saturating_add(1);
        current.updated_at_ms = now_ms();
        current.journal_actor = "patrol".into();
        save_run(runtime, &current)?;
        return Ok(true);
    }
    let reason = run.stop.as_ref().map(|stop| stop.reason.as_str()).unwrap_or("执行已结束，但用户需求仍未交付；PM 未在处理期限内作出决定");

    if !state.sessions.summary(&parent).await.is_ok_and(|session| !session.archived) {
        recovery::ensure_human_exit(state, runtime, &run, "d",
            Some("没有活着的 PM 会话可以接管恢复；请在项目中新建 PM 会话后处理并提交平台反馈。")
        ).await?;
        return Ok(true);
    }
    let actor = if run.stop.as_ref().is_some_and(|stop| stop.cause_code == "pmRecovery") { "pm" } else { "patrol" };
    let transition = super::start_recovery(state, &run.workspace_id, &parent, &run.id, reason, actor).await?;
    for (session, message) in transition.sessions {
        if let Err(error) = start_assigned(state, &run.workspace_id, &transition.status.id, &session, message).await {
            super::abort_launch(state, &run.workspace_id, &transition.status.id).await?;
            return Err(error);
        }
    }
    Ok(true)
}

/// A newly acquired request writer never inherits an old Worker implicitly.
/// Fence every recorded Session before allowing writes, then persist a
/// stop decision for each unfinished Run. The next patrol performs cleanup.
pub(super) async fn verify_request_takeover(state: &Shared, runtime: &RuntimeStore, seed: &RunRecord) -> Result<()> {
    let group_id = request::group_id(seed).to_string();
    // A corrupt request snapshot may hide an executing sibling; takeover must
    // fail closed instead of declaring the visible subset safe.
    let group = request_runs(runtime, &group_id)?;
    if group.is_empty() { bail!("请求接管时未找到 Run"); }
    let mut sessions = BTreeSet::new();
    let mut preserved_runs = BTreeSet::new();
    let mut preserved_sessions = BTreeSet::new();
    let mut invalid_snapshots = BTreeMap::new();
    for run in &group {
        if !run.unfinished() { continue; }
        sessions.extend(run.executor_session_id.iter().cloned());
        sessions.extend(run.nodes.values().filter_map(|node| node.session_id.clone()));
        if let Err(error) = structured::validate_snapshot(run) {
            invalid_snapshots.insert(run.id.clone(), format!("结构化执行快照无法恢复：{error:#}"));
            continue;
        }
        // An old Agent process that has stopped cannot write after the OS
        // lock changes hands. Keep its durable Session so the next patrol can
        // either retain a pending question or mark its Worker recoverable for
        // an explicit same-Session continue. A live process, unavailable
        // Session, or partially missing assignment still gets fenced below.
        if run.status() == "running" {
            // A route wait before any Session assignment has no old process
            // or submitted side effect to fence. Preserve the validated open
            // graph and its decision clock across writer ownership changes.
            if run.human_decision_ready() && run.executor_session_id.is_none()
                && run.nodes.values().all(|node| node.session_id.is_none())
            {
                preserved_runs.insert(run.id.clone());
                continue;
            }
            let running_nodes = run.nodes.values().filter(|node| node.status() == "running").collect::<Vec<_>>();
            // A submitted result is durable before its Worker is retired.
            // Fence the old process, then finish_nodes settles that saved
            // outcome without replaying the operation.
            if running_nodes.is_empty() && run.nodes.values().any(|node| node.status() == "finishing") {
                preserved_runs.insert(run.id.clone());
                if let Some(executor) = &run.executor_session_id {
                    if matches!(state.sessions.worker_continuation(executor).await,
                            crate::session::manager::WorkerContinuation::Ready) {
                        preserved_sessions.insert(executor.clone());
                    }
                }
                continue;
            }
            let active = running_nodes.iter().filter_map(|node| node.session_id.as_deref()).collect::<Vec<_>>();
            if !active.is_empty() && active.len() == running_nodes.len() {
                let mut continuable = true;
                for id in &active {
                    if !matches!(state.sessions.worker_continuation(id).await,
                            crate::session::manager::WorkerContinuation::Ready)
                    {
                        continuable = false;
                        break;
                    }
                }
                if continuable {
                    let mut owned = active.into_iter().map(str::to_string).collect::<BTreeSet<_>>();
                    if let Some(executor) = &run.executor_session_id {
                        if !matches!(state.sessions.worker_continuation(executor).await,
                            crate::session::manager::WorkerContinuation::Ready) {
                            continuable = false;
                        } else {
                            owned.insert(executor.clone());
                        }
                    }
                    if continuable {
                        preserved_runs.insert(run.id.clone());
                        preserved_sessions.extend(owned);
                    }
                }
            }
        }
    }
    for session_id in sessions {
        if preserved_sessions.contains(&session_id) { continue; }
        match state.sessions.fence_execution(&session_id).await {
            Ok(()) => {}
            Err(error) if error.is::<crate::session::manager::SessionMissing>() => {}
            Err(error) => return Err(error).with_context(|| format!("请求接管无法冻结 Session {session_id}")),
        }
    }
    set_request_writer_verified(runtime, seed, true)?;
    let persist = (|| -> Result<()> {
        for original in &group {
            if !original.program_open() { continue; }
            if preserved_runs.contains(&original.id) { continue; }
            let _guard = lock_run(runtime, &original.id)?;
            let mut run = load_run(runtime, &original.id)?;
            if !run.program_open() { continue; }
            let reason = invalid_snapshots.get(&original.id).cloned().unwrap_or_else(||
                "请求锁接管：旧执行已冻结，等待核对副作用后恢复".into());
            request_stop(&mut run, "blocked", reason);
            run.journal_actor = "patrol".into();
            run.revision = run.revision.saturating_add(1);
            run.updated_at_ms = now_ms();
            save_run(runtime, &run)?;
        }
        Ok(())
    })();
    if persist.is_err() {
        set_request_writer_verified(runtime, seed, false)?;
    }
    persist
}

/// Result acceptance and process retirement are separate durable steps. Never
/// hold a Run lock while shutting down the Worker that just called complete.
async fn finish_nodes(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<()> {
    let snapshot = load_run(runtime, run_id)?;
    if snapshot.status() != "running" {
        return Ok(());
    }
    for (node_id, node) in &snapshot.nodes {
        if node.status() != "finishing" {
            continue;
        }
        let activity = if let Some(id) = &node.session_id {
            state.sessions.execution_activity(id).await.ok()
        } else {
            None
        };
        let cleanup: Result<()> = async {
            if let Some(id) = &node.session_id {
                state.sessions.fence_execution(id).await?;
                state.sessions.close(id).await?;
            }
            Ok(())
        }
        .await;
        let sessions = {
            let _guard = lock_run(runtime, run_id)?;
            let mut run = load_run(runtime, run_id)?;
            let _request = request::request_lock(runtime, request::group_id(&run))?;
            if run.status() != "running" || request::ensure_open(runtime, &run).is_err() {
                return Ok(());
            }
            if run.nodes[node_id].status() != "finishing" {
                continue;
            }
            if let Err(error) = cleanup {
                request_stop(
                    &mut run,
                    "blocked",
                    format!("节点 {node_id} 收尾失败：{error:#}"),
                );
                run.revision += 1;
                save_run(runtime, &run)?;
                return Ok(());
            }
            if let Some(activity) = activity {
                run.nodes.get_mut(node_id).expect("node").activity = activity;
            }
            let outcome = run.nodes[node_id].outcome.clone().unwrap_or_default();
            run.nodes.get_mut(node_id).expect("node").phase = facts::NodePhase::Settled;
            if run.engine.is_some() {
                structured::settled(&mut run, node_id)?;
                structured::finalize(runtime, &mut run).await;
                run.revision += 1;
                run.updated_at_ms = now_ms();
                save_run(runtime, &run)?;
                continue;
            }
            let definition = runtime_node(&run, node_id)?;
            let targets = definition
                .on
                .get(outcome.name())
                .cloned()
                .unwrap_or_default();
            let leases_before = run.leases.clone();
            let sessions =
                match activate(state, &runtime.project_root, runtime, &mut run, targets.clone()).await {
                    Ok(sessions) => sessions,
                    Err(error) => {
                        let reason = format!("节点 {node_id} 后续派发失败：{error:#}");
                        if is_route_unavailable(&error) {
                            defer_unavailable_route(&mut run, &targets, reason);
                        } else {
                            request_stop(&mut run, "blocked", reason);
                        }
                        Vec::new()
                    }
                };
            settle_if_terminal(&mut run);
            release_recovery_handoff_leases(runtime, &mut run).await;
            run.revision += 1;
            run.updated_at_ms = now_ms();
            record_assigned_messages(&mut run, &sessions)?;
            if run.status() == "completed" {
                if let Some(executor) = run.executor_session_id.clone() {
                    let event = flow_message(
                        &run,
                        "run.completed",
                        None,
                        &executor,
                        &run.parent_session_id,
                        Some(run.revision),
                        serde_json::json!({"status": run.status()}),
                    )?;
                    push_flow_message(&mut run, event);
                }
            }
            if let Err(error) = save_run(runtime, &run) {
                let leases = run
                    .leases
                    .iter()
                    .filter(|(id, _)| !leases_before.contains_key(*id))
                    .map(|(_, lease)| lease.clone())
                    .collect::<Vec<_>>();
                return Err(
                    with_activation_cleanup(state, runtime, &sessions, &leases, error).await,
                );
            }
            if run.status() == "completed" {
                release_leases(runtime, &run).await?;
            }
            sessions
        };
        for (session, message) in sessions {
            if let Err(error) =
                start_assigned(state, &snapshot.workspace_id, run_id, &session, message).await
            {
                abort_launch(state, &snapshot.workspace_id, run_id).await?;
                return Err(error);
            }
        }
    }
    Ok(())
}

async fn reconcile(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<()> {
    let run = {
        let _guard = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        let root = load_run(runtime, request::group_id(&run))?;
        if request::cancelled(&root)
            && !matches!(
                run.status(),
                "completed" | "cancelled" | "cancelling"
            )
        {
            request_stop(&mut run, "cancelled", "恢复原请求的已持久化取消决定".into());
        }
        let previous_status = run.status().to_string();
        if run.status() == "running" {
            supervision::observe(state, runtime, &mut run).await?;

            let mut lost = Vec::new();
            let mut failed = Vec::new();
            let mut alive: Option<Option<u32>> = None;
            let mut unavailable: Option<String> = None;
            for (node_id, node) in &run.nodes {
                if node.status() != "running" || node.interruption.is_some()
                    || now_ms() - node.assigned_at_ms.max(run.created_at_ms) < 5_000
                {
                    continue;
                }
                let Some(session_id) = &node.session_id else {
                    if node.uses == "pack.script" && node.outcome.is_none() {
                        unavailable = Some(format!("脚本 {node_id} 已启动但结果未知；核对副作用与进程，不自动重放"));
                    }
                    continue;
                };
                let summary = state.sessions.summary(session_id).await;
                if summary
                    .as_ref()
                    .is_ok_and(|session| session.status == SessionStatus::Waiting)
                {
                    continue;
                }
                if !state.sessions.has_execution(session_id).await {
                    if let Ok(session) = &summary {
                        if session.status == SessionStatus::Failed && node.uses == "agent.session" {
                            failed.push((
                                node_id.clone(),
                                session_id.clone(),
                                session.agent_id.clone(),
                                session.model_id.clone(),
                            ));
                            continue;
                        }
                    }
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
                    if node.uses != "agent.session" {
                        unavailable = Some(format!(
                            "节点 {node_id} 的 Worker 已停止，尚未提交节点结果；交回 PM 核对后处理"
                        ));
                        continue;
                    }
                    // Every node is asked, and a sibling that cannot continue
                    // no longer decides for the ones that can: continuation is
                    // a per-node fact, while `blocked` retires the whole
                    // program and is not reversible.
                    match state.sessions.worker_continuation(session_id).await {
                        crate::session::manager::WorkerContinuation::Ready => {
                            lost.push((node_id.clone(), session_id.clone()));
                        }
                        crate::session::manager::WorkerContinuation::ProcessAlive { pid } => {
                            alive = alive.or(Some(pid));
                        }
                        crate::session::manager::WorkerContinuation::Unavailable { reason } => {
                            unavailable = unavailable.or(Some(reason));
                        }
                    }
                }
            }
            for (node_id, session_id, previous_agent_id, previous_model_id) in failed {
                let definition = runtime_node(&run, &node_id)?.clone();
                let role_id = definition
                    .inputs
                    .role
                    .as_deref()
                    .ok_or_else(|| anyhow!("节点 {node_id} 缺少 with.role"))?;
                let role = run
                    .roles
                    .get(role_id)
                    .cloned()
                    .ok_or_else(|| anyhow!("角色不存在：{role_id}"))?;
                // A legacy role deliberately pins an exact destination. It
                // keeps the existing explicit recovery path; tag roles are
                // the contracts that authorize automatic route replacement.
                if role.schema == LEGACY_ROLE_SCHEMA || run.agent_target.is_some() {
                    lost.push((node_id, session_id));
                    continue;
                }
                run.exclude_route(&previous_agent_id, previous_model_id.as_deref());
                let mut last_switch_error = None;
                let selected = loop {
                    let excluded = run.route_exclusions();
                    let (route, providers) = match resolve_role_route_excluding(
                        state, &role, &excluded, run.agent_target.as_ref(),
                    )
                    .await
                    {
                        Ok(resolved) => resolved,
                        Err(error) => {
                            let failed_start = last_switch_error
                                .as_deref()
                                .map(|detail| format!("；后续候选启动失败：{detail}"))
                                .unwrap_or_default();
                            request_stop_with_cause(
                                &mut run,
                                "blocked",
                                format!(
                                    "workflowTagRouteExhausted: 节点 {node_id} 的路由 {}/{} 执行失败，且没有其他匹配角色标签的可用 Agent 与模型{failed_start}；{error:#}",
                                    previous_agent_id,
                                    previous_model_id.as_deref().unwrap_or("default")
                                ),
                                "routeUnavailable",
                            );
                            break None;
                        }
                    };
                    let target = genehub_proto::SessionAgentTarget {
                        agent_id: route.agent_id.clone(),
                        model_id: route.model_id.clone(),
                        mode_id: route.mode_id.clone(),
                        effort_id: route.effort_id.clone(),
                        fast: None,
                        runtime_values: route.runtime_values.clone(),
                    };
                    match state
                        .sessions
                        .switch_managed_agent(&session_id, target, &providers)
                        .await
                    {
                        Ok(summary) => {
                            observability::stamp_rate(state, &summary).await?;
                            break Some((route, providers));
                        }
                        Err(error) => {
                            let detail = format!(
                                "{}/{}: {error:#}",
                                route.agent_id,
                                route.model_id.as_deref().unwrap_or("default")
                            );
                            tracing::warn!(
                                run = %run.id,
                                node = %node_id,
                                session = %session_id,
                                route = %detail,
                                "Workflow failover candidate became unavailable"
                            );
                            last_switch_error = Some(detail);
                            run.exclude_route(&route.agent_id, route.model_id.as_deref());
                        }
                    }
                };
                let Some((route, providers)) = selected else {
                    break;
                };
                let message = reroute_message(
                    &run,
                    &definition,
                    &previous_agent_id,
                    previous_model_id.as_deref(),
                );
                let record = run.nodes.get_mut(&node_id).expect("failed node");
                record.assigned_at_ms = now_ms();
                if let Some(executor) = run.executor_session_id.clone() {
                    let flow = flow_message(
                        &run,
                        "node.routeChanged",
                        Some(&node_id),
                        &session_id,
                        &executor,
                        Some(run.revision.saturating_add(1)),
                        serde_json::json!({
                            "sessionId": session_id,
                            "previous": {
                                "agentId": previous_agent_id,
                                "modelId": previous_model_id,
                            },
                            "current": {
                                "agentId": route.agent_id,
                                "modelId": route.model_id,
                            },
                        }),
                    )?;
                    push_flow_message(&mut run, flow);
                }
                run.revision = run.revision.saturating_add(1);
                run.updated_at_ms = now_ms();
                // Persist the exclusion and route-change evidence before the
                // replacement Agent receives work. A crash can then resume
                // from the new binding without choosing the dead route again.
                save_run(runtime, &run)?;
                state
                    .sessions
                    .send(&session_id, message, Vec::new(), &providers, None, None)
                    .await?;
            }
            if run.program_open() {
                if let Some(pid) = alive {
                    request_stop(&mut run, "blocked", format!("旧 Worker 仍在运行，暂停续接（pid {pid:?}）"));
                } else if let Some(reason) = unavailable {
                    request_stop(&mut run, "blocked", reason);
                } else if !lost.is_empty() && run.engine.is_none() {
                    request_stop(&mut run, "blocked", "旧版流程的 Worker 已停止；请核对后建立 v2 后继".into());
                } else if !lost.is_empty() {
                    for (id, session_id) in lost {
                        let node = run.nodes.get_mut(&id).expect("observed node");
                        node.interruption = Some(facts::Interruption {
                            occurrence: 0, session_id, attempt: node.attempt, observed_at_ms: now_ms(),
                            reason: "Worker 与 daemon 失联；原 Session 与租约保留，待核验续接".into(),
                        });
                    }
                    run.journal_actor = "patrol".into();
                    run.revision = run.revision.saturating_add(1);
                    run.updated_at_ms = now_ms();
                }
            }
        }
        if previous_status != run.status() {
            run.revision += 1;
            run.updated_at_ms = now_ms();
            run.journal_actor = "patrol".into();
        }
        save_run(runtime, &run)?;
        run
    };
    if !matches!(run.status(), "stopping" | "cancelling") {
        return Ok(());
    }
    let mut session_ids = run
        .nodes
        .values()
        .filter_map(|node| node.session_id.clone())
        .collect::<BTreeSet<_>>();
    session_ids.extend(run.executor_session_id.clone());
    let mut errors = run.nodes.iter().filter(|(_, node)| node.uses == "pack.script"
        && node.status() == "running" && node.outcome.is_none())
        .map(|(id, _)| format!("脚本 {id} 结果及进程退休未确认；保留关闭义务"))
        .collect::<Vec<_>>();
    // The durable Session fence closes the late-send/reopen race. Keep the
    // request and Run locks free while adapters and processes are being stopped.
    for session_id in session_ids {
        let result: Result<()> = async {
            if let Err(error) = state.sessions.fence_execution(&session_id).await {
                // Reservation precedes Session creation, which can fail, and a
                // durable record can be lost while the daemon is down. Neither
                // state has a Session to fence or reap, and no retry can bring
                // one back: refusing here would leave the Run stopping forever.
                // Existing Sessions and every other lookup error still fail
                // closed through the normal cleanup path.
                if error.is::<crate::session::manager::SessionMissing>() {
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
    if !matches!(current.status(), "stopping" | "cancelling") {
        return Ok(());
    }
    let stop = current
        .stop
        .clone()
        .ok_or_else(|| anyhow!("stopping Run has no durable stop decision"))?;
    if errors.is_empty() {
        for node in current.nodes.values_mut() {
            match node.status() {
                "running" | "finishing" | "interrupted" => {
                    // An accepted result survives cancellation and cleanup.
                    if node.outcome.is_none() { node.reason = Some(stop.reason.clone()); }
                    node.phase = facts::NodePhase::Settled;
                    node.interruption = None;
                    node.route_wait = None;
                }
                "pending" => node.phase = facts::NodePhase::Unreached,
                _ => {}
            }
        }
        structured::retired(&mut current)?;
        current.legacy_program_status = current.engine.is_none().then(|| stop.target.clone());
        current.retired_at_ms = Some(now_ms());
        current.recovery = None;
        current.leases.clear();
        current.stop.as_mut().expect("stop decision").cleanup_error = None;
        if let Some(executor) = current.executor_session_id.clone() {
            let message = flow_message(
                &current,
                &format!("run.{}", current.status()),
                None,
                &executor,
                &current.parent_session_id,
                Some(current.revision),
                serde_json::json!({"status": current.status(), "reason": stop.reason}),
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
    current.journal_actor = stop.actor;
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
    if run.parent_session_id != session_id
        && !exception_authority(state, &run.workspace_id, session_id).await?
    {
        bail!("the task belongs to a different PM session");
    }
    Ok(())
}
