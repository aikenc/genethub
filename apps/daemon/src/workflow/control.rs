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
                                    matches!(
                                        run.status.as_str(),
                                        "running" | "stopping" | "cancelling" | "recoverable"
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
                        owned
                            .iter()
                            .filter(|run| executing_runs.contains(&run.id))
                            .count() as u32,
                    );
                    for run in &owned {
                        match run.status.as_str() {
                            "running" => summary.running += 1,
                            "stopping" | "cancelling" => summary.stopping += 1,
                            "blocked" | "failed" | "recoverable" => summary.blocked += 1,
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
                            human_exit: recovery::read_human_exit(&runtime, run).ok().flatten()
                                .map(|exit| genehub_proto::WorkflowHumanExitStatus {
                                    kind: exit.kind, request_id: exit.request_id,
                                    pm_session_id: exit.pm_session_id, reason: exit.reason,
                                    created_at_ms: exit.created_at_ms, answer: exit.answer,
                                }),
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
                                |group| group.iter().any(|run| supervision::report_pending(run)),
                            )),
                            run_id: run.id.clone(),
                            task_id: run.task_id.clone(),
                            workflow_id: run.workflow_id.clone(),
                            status: run.status.clone(),
                            revision: run.revision,
                            active_nodes: run
                                .nodes
                                .iter()
                                .filter(|(_, node)| {
                                    matches!(node.status.as_str(), "running" | "finishing")
                                })
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

fn recovery_targets(recovery: &Recovery) -> Vec<(String, String)> {
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
    run.status = if target == "cancelled" {
        "cancelling"
    } else {
        "stopping"
    }
    .into();
    run.stop = Some(StopRequest {
        target: target.into(),
        reason,
        cause_code: cause_code.into(),
        actor: String::new(),
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
    let _guard = lock_run(&runtime, run_id)?;
    let mut run = load_run(&runtime, run_id)?;
    let _request = request::request_lock(&runtime, request::group_id(&run))?;
    request::ensure_open(&runtime, &run)?;
    if run.status != "running" {
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
        request_stop_with_cause(
            &mut run,
            "blocked",
            "流程或活动达到期限，或原始请求耗尽 LLM 调用上限".into(),
            if request_budget_exhausted {
                "requestBudget"
            } else {
                "activityDeadline"
            },
        );
        run.revision += 1;
        save_run(&runtime, &run)?;
        return Ok(());
    }
    if !run.nodes.values().any(|node| {
        node.status == "running" && node.session_id.as_deref() == Some(session.id.as_str())
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
        if run.status != "running" {
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
        .is_some_and(|request| request.cancelled)
    {
        return run_status(&runtime, &run);
    }
    if run.revision != expected_revision {
        bail!("Workflow revision 冲突：先重新读取 workflow get");
    }
    let group = request_runs(&runtime, &root.id)?;
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
    link.cancelled_by_agent = by_agent;
    root.request = Some(link);
    root.revision += 1;
    save_run(&runtime, &root)?; // The request fence survives a partial cascade.
    for previous in group {
        if let Some(exit) = recovery::read_human_exit(&runtime, &previous)? {
            state.sessions.cancel_workflow_question(&exit.pm_session_id, &exit.request_id).await?;
        }
        // Retire the notices where they were actually delivered, which is not
        // necessarily the Session that dispatched the Run.
        let recipient = super::notice_recipient(state, &previous).await?;
        state
            .sessions
            .discard_workflow_inputs(&recipient, &previous.id)
            .await?;
        let mut current = load_run(&runtime, &previous.id)?;
        if matches!(current.status.as_str(), "completed" | "cancelled") {
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
        if run.status != "recoverable" {
            bail!(
                "Run 当前为 {}，没有可恢复的未交卷操作；--retry-of 会从流程入口新建 Run",
                run.status
            );
        }
        let recovery = run
            .recovery
            .clone()
            .ok_or_else(|| anyhow!("recoverable Run 缺少恢复记录"))?;
        if run
            .stop
            .as_ref()
            .is_some_and(|stop| stop.cleanup_error.is_some())
        {
            bail!("旧执行尚未清理干净，不可恢复");
        }
        if request::budget_exhausted(&runtime, &run, now_ms())? {
            bail!("原始请求预算已耗尽；先核对并调整共享预算");
        }
        if recovery.reuse_session {
            let mut assignments = Vec::new();
            for (node_id, session_id) in recovery_targets(&recovery) {
                let node = run
                    .nodes
                    .get(&node_id)
                    .ok_or_else(|| anyhow!("恢复节点不存在"))?;
                if node.status != "interrupted"
                    || node.session_id.as_deref() != Some(session_id.as_str())
                {
                    bail!("恢复节点状态不匹配；请先 workflow get/check 核对");
                }
                match state.sessions.worker_continuation(&session_id).await {
                    crate::session::manager::WorkerContinuation::Ready => {}
                    crate::session::manager::WorkerContinuation::ProcessAlive { pid } => {
                        bail!(
                            "旧 Worker 仍在运行，暂停续接{}",
                            pid.map(|pid| format!("（pid {pid}）")).unwrap_or_default()
                        );
                    }
                    crate::session::manager::WorkerContinuation::Unavailable { reason } => {
                        bail!("{reason}");
                    }
                }
                let definition = runtime_node(&run, &node_id)?;
                let summary = state.sessions.summary(&session_id).await?;
                let message = continue_message(&run, &definition);
                let record = run.nodes.get_mut(&node_id).expect("validated node");
                record.status = "running".into();
                record.assigned_at_ms = now_ms();
                assignments.push((summary, message));
            }
            run.supervision.recovery_wait_ms = run
                .supervision
                .recovery_wait_ms
                .saturating_add(now_ms().saturating_sub(recovery.waiting_since_ms));
            run.recovery = None;
            run.stop = None;
            run.status = "running".into();
            run.revision = run.revision.saturating_add(1);
            run.updated_at_ms = now_ms();
            if let Some(executor) = run.executor_session_id.clone() {
                let message = flow_message(
                    &run,
                    "node.continued",
                    Some(&recovery.node_id),
                    &executor,
                    &run.parent_session_id,
                    Some(run.revision),
                    serde_json::json!({
                        "previousSessionId": recovery.previous_session_id,
                        "reusedSession": true
                    }),
                )?;
                push_flow_message(&mut run, message);
            }
            save_run(&runtime, &run)?;
            Some(assignments)
        } else {
            let node = run
                .nodes
                .get(&recovery.node_id)
                .ok_or_else(|| anyhow!("恢复节点不存在"))?;
            if node.status != "interrupted"
                || node.session_id.as_deref() != Some(&recovery.previous_session_id)
                || node.attempt != 0
            {
                bail!("恢复节点状态不匹配；请先 workflow get/check 核对");
            }
            if !run.leases.is_empty()
                || runtime_node(&run, &recovery.node_id)?
                    .inputs
                    .write_lease
                    .is_some()
            {
                bail!("带写租约的操作不可自动重派；交回 PM 核对副作用");
            }
            let old = run
                .nodes
                .get_mut(&recovery.node_id)
                .expect("validated node");
            old.prior_activity.push(std::mem::take(&mut old.activity));
            // The attempt counter is the node's real retry depth. Its first
            // pending time is never rewritten, so a reader can still see how
            // long the node has existed rather than only the current attempt.
            old.attempt = old.attempt.saturating_add(1);
            let attempt = old.attempt;
            old.status = "pending".into();
            old.session_id = None;
            old.assigned_at_ms = 0;
            old.settled_at_ms = 0;
            run.supervision.recovery_wait_ms = run
                .supervision
                .recovery_wait_ms
                .saturating_add(now_ms().saturating_sub(recovery.waiting_since_ms));
            run.recovery = None;
            run.stop = None;
            run.status = "running".into();
            run.revision = run.revision.saturating_add(1);
            run.updated_at_ms = now_ms();
            if let Some(executor) = run.executor_session_id.clone() {
                let message = flow_message(
                    &run,
                    "node.recovered",
                    Some(&recovery.node_id),
                    &executor,
                    &run.parent_session_id,
                    Some(run.revision),
                    serde_json::json!({"previousSessionId": recovery.previous_session_id, "attempt": attempt}),
                )?;
                push_flow_message(&mut run, message);
            }
            save_run(&runtime, &run)?;
            None
        }
    };
    if let Some(assignments) = assignments {
        for (session, message) in assignments {
            start_assigned(state, workspace_id, run_id, &session, message).await?;
        }
    } else {
        structured::drive(state, &runtime, run_id).await?;
    }
    run_status(&runtime, &load_run(&runtime, run_id)?)
}

pub(crate) async fn budget(
    state: &Shared,
    workspace_id: &str,
    actor_session_id: Option<&str>,
    run_id: &str,
    expected_revision: u64,
    max_runs: Option<u32>,
    deadline_seconds: Option<u64>,
    max_llm_rounds: Option<u64>,
) -> Result<WorkflowRunStatus> {
    validate_id(run_id, "runId")?;
    if max_runs.is_none() && deadline_seconds.is_none() && max_llm_rounds.is_none() {
        bail!("workflow.budget 至少需要一个预算上限");
    }
    if max_runs.is_some_and(|value| value == 0 || value > request::MAX_CONFIGURED_REQUEST_RUNS) {
        bail!(
            "maxRuns 必须在 1..={} 之间",
            request::MAX_CONFIGURED_REQUEST_RUNS
        );
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
    // A completed business Run releases its long-lived writer. Budget changes
    // can still be made before a successor, so reacquire and verify ownership
    // before mutating the shared request record.
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
    if let Some(value) = max_runs {
        link.budget.max_runs = value;
    }
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
    if matches!(root.status.as_str(), "running" | "stopping" | "cancelling") {
        root.updated_at_ms = now_ms();
    }
    save_run(&runtime, &root)?;
    run_status(&runtime, &root)
}

static RECONCILING: LazyLock<Mutex<BTreeSet<PathBuf>>> =
    LazyLock::new(|| Mutex::new(BTreeSet::new()));
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
            let mut pruned = true;
            for run in &runs {
                if let Err(error) = journal::prune(&runtime, run, now) {
                    pruned = false;
                    tracing::warn!(run = %run.id, %error, "workflow journal retention remains pending");
                }
            }
            if pruned {
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
            if matches!(run.status.as_str(), "completed" | "cancelled") {
                if let Err(error) = release_request_writer_if_resolved(&runtime, run) {
                    tracing::warn!(run = %run.id, %error, "workflow request writer release remains pending");
                }
            }
        }
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
                || matches!(
                    run.status.as_str(),
                    "running" | "stopping" | "cancelling" | "recoverable"
                )
                || run.status == "blocked"
                || (!cancelled.contains(request::group_id(&run))
                    && supervision::report_pending(&run));
            if !unfinished {
                continue;
            }
            match claim_request_writer(&runtime, &run) {
                Ok(true) => {}
                Ok(false) => continue,
                Err(error) => {
                    tracing::warn!(run = %run.id, %error, "workflow request writer unavailable");
                    continue;
                }
            }
            if !request_writer_verified(&runtime, &run).unwrap_or(false) {
                if let Err(error) = verify_request_takeover(state, &runtime, &run).await {
                    tracing::warn!(run = %run.id, %error, "workflow request takeover remains pending");
                    continue;
                }
            }
            // Retain per-Run de-duplication. The request writer and operation
            // locks serialize mutations across its Run history.
            let key = runtime.root.join(&run.id);
            let inserted = RECONCILING
                .lock()
                .map(|mut jobs| jobs.insert(key.clone()))
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
                    }
                    if let Err(error) = maybe_resolve_recovery_successor(&runtime, &run.id) {
                        tracing::warn!(run = %run.id, %error, "workflow recovery successor remains pending");
                    }
                    if let Err(error) = maybe_resume_initial_route(&owner, &runtime, &run.id).await {
                        tracing::warn!(run = %run.id, %error, "workflow route resumption remains pending");
                    }
                    match maybe_start_recovery(&owner, &runtime, &run.id).await {
                        Ok(true) => return,
                        Ok(false) => {}
                        Err(error) => {
                            if format!("{error:#}").contains("recoveryBudgetExceeded") {
                                if let Ok(current) = load_run(&runtime, &run.id) {
                                    if let Err(handoff) = recovery::ensure_human_exit(&owner, &runtime, &current, "c", None).await {
                                        tracing::warn!(run = %run.id, %handoff, "recovery budget Human exit remains pending");
                                    }
                                }
                            }
                            tracing::warn!(run = %run.id, %error, "workflow recovery start remains pending");
                        }
                    }
                    if let Ok(current) = load_run(&runtime, &run.id) {
                        let exit_kind = recovery::read_human_exit(&runtime, &current)
                            .ok().flatten().map(|exit| exit.kind);
                        let kind = exit_kind.as_deref().or_else(|| recovery::classify_human_exit(&current));
                        if let Some(kind) = kind {
                            if let Err(error) = recovery::ensure_human_exit(&owner, &runtime, &current, kind, None).await {
                                tracing::warn!(run = %run.id, %error, "workflow Human exit remains pending");
                            }
                        }
                    }
                    if let Err(error) = supervision::deliver_notice(&owner, &runtime, &run.id).await {
                        tracing::warn!(run = %run.id, %error, "workflow PM handoff remains pending");
                    }
                };
                if tokio::time::timeout(Duration::from_secs(300), patrol).await.is_err() {
                    tracing::error!(run = %run.id, "workflow patrol job timed out; next tick will retry");
                }
            });
        }
    }
    LAST_PATROL_FINISHED_MS.store(now_ms(), Ordering::Relaxed);
}

pub(super) fn maybe_resolve_recovery_successor(runtime: &RuntimeStore, run_id: &str) -> Result<bool> {
    let _guard = lock_run(runtime, run_id)?;
    let mut run = load_run(runtime, run_id)?;
    if run.handles.is_empty() || run.status != "blocked"
        || !run.stop.as_ref().is_some_and(|stop| stop.cause_code == "recoveryNoExit")
    {
        return Ok(false);
    }
    let _request = request::request_lock(runtime, request::group_id(&run))?;
    let group = request_runs(runtime, request::group_id(&run))?;
    if group.iter().find(|item| item.id == request::group_id(&run))
        .is_some_and(request::cancelled) {
        return Ok(false);
    }
    let handled = run.handles.iter().map(|handle| handle.run_id.as_str()).collect::<BTreeSet<_>>();
    let successor = group.iter().any(|other| other.handles.is_empty()
        && other.created_at_ms >= run.created_at_ms
        && other.request.as_ref().and_then(|link| link.retry_of.as_deref())
            .is_some_and(|previous| previous == run.id || handled.contains(previous))
        && other.status != "cancelled");
    if !successor {
        return Ok(false);
    }
    run.status = "completed".into();
    run.stop = None;
    run.journal_actor = "pm".into();
    run.revision = run.revision.saturating_add(1);
    run.updated_at_ms = now_ms();
    save_run(runtime, &run)?;
    Ok(true)
}

/// A blocked first node has produced no Worker side effects. Once its role
/// route is available, the patrol can restart that initial assignment without
/// guessing how to replay a partially executed graph.
async fn maybe_resume_initial_route(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<bool> {
    let (workspace_id, sessions) = {
        let _guard = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        let entry = run.definition.entry.clone();
        if run.status != "blocked" || !run.handles.is_empty() || run.engine.is_some()
            || !run.stop.as_ref().is_some_and(|stop| stop.cause_code == "routeUnavailable")
            || run.nodes.get(&entry).is_none_or(|node| node.status != "blocked" || node.session_id.is_some())
            || run.nodes.iter().any(|(id, node)| id != &entry && node.status != "unreached")
            || recovery::read_human_exit(runtime, &run)?.is_some()
        {
            return Ok(false);
        }
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        request::ensure_open(runtime, &run)?;
        let definition = runtime_node(&run, &entry)?;
        let role = run.roles.get(definition.inputs.role.as_deref().unwrap_or_default())
            .ok_or_else(|| anyhow!("Workflow entry role is missing"))?;
        if resolve_role_route(state, role).await.is_err() { return Ok(false); }
        for node in run.nodes.values_mut() {
            node.status = "pending".into();
            node.reason = None;
            node.assigned_at_ms = 0;
            node.settled_at_ms = 0;
        }
        run.status = "running".into();
        run.stop = None;
        let leases_before = run.leases.clone();
        let sessions = activate(state, &runtime.project_root, runtime, &mut run, vec![entry]).await?;
        settle_if_terminal(&mut run);
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

/// A Human's explicit acceptance can settle a blocked business Run whose
/// machine-only acceptance gate could not run. Keep the recovery writer until
/// both snapshots are committed; retrying after either save is idempotent.
pub(super) fn complete_human_acceptance(runtime: &RuntimeStore, recovery_id: &str) -> Result<()> {
    let recovery = load_run(runtime, recovery_id)?;
    let target_id = recovery.handles.first().ok_or_else(|| anyhow!("not a recovery Run"))?.run_id.clone();
    let mut ids = [recovery_id, target_id.as_str()];
    ids.sort();
    let _first = lock_run(runtime, ids[0])?;
    let _second = lock_run(runtime, ids[1])?;
    let _request = request::request_lock(runtime, request::group_id(&recovery))?;
    let mut target = load_run(runtime, &target_id)?;
    let mut recovery = load_run(runtime, recovery_id)?;
    request::ensure_open(runtime, &target)?;
    if target.status != "completed" {
        if target.status != "blocked" { bail!("Human acceptance target is no longer blocked"); }
        target.status = "completed".into();
        target.stop = None;
        target.journal_actor = "human".into();
        target.revision = target.revision.saturating_add(1);
        target.updated_at_ms = now_ms();
        save_run(runtime, &target)?;
    }
    if recovery.status != "completed" {
        if recovery.status != "blocked" { bail!("Human acceptance recovery is no longer blocked"); }
        recovery.status = "completed".into();
        recovery.stop = None;
        recovery.journal_actor = "human".into();
        recovery.revision = recovery.revision.saturating_add(1);
        recovery.updated_at_ms = now_ms();
        save_run(runtime, &recovery)?;
    }
    Ok(())
}

async fn maybe_start_recovery(state: &Shared, runtime: &RuntimeStore, run_id: &str) -> Result<bool> {
    let run = load_run(runtime, run_id)?;
    if run.status != "blocked" || !run.handles.is_empty() {
        return Ok(false);
    }
    let group = request_runs(runtime, request::group_id(&run))?;
    if group.iter().find(|item| item.id == request::group_id(&run))
        .is_some_and(request::cancelled) {
        return Ok(false);
    }
    if group.iter().filter(|item| item.handles.is_empty())
        .any(|item| item.id != run.id && item.created_at_ms > run.created_at_ms)
    {
        return Ok(false);
    }
    let previous = group.iter().filter(|item| item.handles.iter().any(|handle| handle.run_id == run.id))
        .max_by_key(|item| (item.created_at_ms, &item.id));
    if let Some(previous) = previous {
        if matches!(previous.status.as_str(), "running" | "stopping" | "cancelling" | "recoverable") {
            return Ok(true);
        }
        if let Some(exit) = recovery::read_human_exit(runtime, previous)? {
            // Human decisions are durable request boundaries. Only a newly
            // approved recovery allowance authorizes another attempt.
            if exit.kind != "c" || exit.answer.as_deref() != Some("approve") {
                return Ok(true);
            }
        } else if previous.status == "blocked" {
            // A recovery failure is handed to a Human by the patrol of that
            // recovery Run. A second attempt needs an explicit budget grant
            // or PM action; blindly launching another Run hides the failure.
            return Ok(true);
        }
    }
    let reason = run.stop.as_ref().map(|stop| stop.reason.as_str()).unwrap_or("execution blocked");
    if run.stop.as_ref().is_some_and(|stop| matches!(stop.cause_code.as_str(), "routeUnavailable" | "requestBudget"))
        || request::budget_exhausted(runtime, &run, now_ms())?
    {
        return Ok(false);
    }
    let parent = super::notice_recipient(state, &run).await?;
    if !state.sessions.summary(&parent).await.is_ok_and(|session| !session.archived) {
        recovery::ensure_human_exit(state, runtime, &run, "d",
            Some("没有活着的 PM 会话可以接管恢复；请在项目中新建 PM 会话后处理并提交平台反馈。")
        ).await?;
        return Ok(true);
    }
    let actor = if reason.starts_with("PM recovery: ") { "pm" } else { "patrol" };
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
        if matches!(run.status.as_str(), "completed" | "cancelled") { continue; }
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
        if run.status == "running" {
            let running_nodes = run.nodes.values().filter(|node| node.status == "running").collect::<Vec<_>>();
            // A submitted result is durable before its Worker is retired.
            // Fence the old process, then finish_nodes settles that saved
            // outcome without replaying the operation.
            if running_nodes.is_empty() && run.nodes.values().any(|node| node.status == "finishing") {
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
            if !matches!(original.status.as_str(), "running" | "recoverable") { continue; }
            if preserved_runs.contains(&original.id) { continue; }
            let _guard = lock_run(runtime, &original.id)?;
            let mut run = load_run(runtime, &original.id)?;
            if !matches!(run.status.as_str(), "running" | "recoverable") { continue; }
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
    if snapshot.status != "running" {
        return Ok(());
    }
    for (node_id, node) in &snapshot.nodes {
        if node.status != "finishing" {
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
            if run.status != "running" || request::ensure_open(runtime, &run).is_err() {
                return Ok(());
            }
            if run.nodes[node_id].status != "finishing" {
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
            run.nodes.get_mut(node_id).expect("node").status = "completed".into();
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
                match activate(state, &runtime.project_root, runtime, &mut run, targets).await {
                    Ok(sessions) => sessions,
                    Err(error) => {
                        request_stop(
                            &mut run,
                            "blocked",
                            format!("节点 {node_id} 后续派发失败：{error:#}"),
                        );
                        Vec::new()
                    }
                };
            settle_if_terminal(&mut run);
            run.revision += 1;
            run.updated_at_ms = now_ms();
            record_assigned_messages(&mut run, &sessions)?;
            if run.status == "completed" {
                if let Some(executor) = run.executor_session_id.clone() {
                    let event = flow_message(
                        &run,
                        "run.completed",
                        None,
                        &executor,
                        &run.parent_session_id,
                        Some(run.revision),
                        serde_json::json!({"status": run.status}),
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
            if run.status == "completed" {
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
        if run.status == "recoverable" && run.recovery.as_ref().is_some_and(|recovery| {
            now_ms().saturating_sub(recovery.waiting_since_ms) >= recovery::DEFAULT_PM_ANSWER_SECONDS as i64 * 1000
        }) {
            request_stop(&mut run, "blocked", "PM 未在期限内续接受阻 Worker，进入恢复流程".into());
        }
        if run.status == "running" {
            supervision::observe(state, runtime, &mut run).await?;
            let mut waiting = false;
            let mut lost = Vec::new();
            let mut failed = Vec::new();
            let mut alive: Option<Option<u32>> = None;
            let mut unavailable: Option<String> = None;
            for (node_id, node) in &run.nodes {
                if node.status != "running"
                    || now_ms() - node.assigned_at_ms.max(run.created_at_ms) < 5_000
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
                    waiting = true;
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
                if role.schema == LEGACY_ROLE_SCHEMA {
                    lost.push((node_id, session_id));
                    continue;
                }
                run.exclude_route(&previous_agent_id, previous_model_id.as_deref());
                let mut last_switch_error = None;
                let selected = loop {
                    let excluded = run.route_exclusions();
                    let (route, providers) = match resolve_role_route_excluding(
                        state, &role, &excluded,
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
                        Ok(_) => break Some((route, providers)),
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
            let continuable = run.status == "running" && !waiting && !lost.is_empty();
            if run.status != "running" {
                // A tag role exhausted every matching route above. The normal
                // stopping path closes Sessions and releases leases before the
                // actionable blocked result becomes terminal.
            } else if continuable && run.engine.is_none() {
                request_stop(
                    &mut run,
                    "blocked",
                    format!(
                        "节点 {} 的 Worker 已停止，尚未提交节点结果；交回 PM 核对后处理",
                        lost.iter()
                            .map(|(id, _)| id.as_str())
                            .collect::<Vec<_>>()
                            .join("、")
                    ),
                );
            } else if !continuable {
                if let Some(pid) = alive {
                    request_stop(
                        &mut run,
                        "blocked",
                        format!(
                            "旧 Worker 仍在运行，暂停续接{}",
                            pid.map(|pid| format!("（pid {pid}）")).unwrap_or_default()
                        ),
                    );
                } else if let Some(reason) = unavailable {
                    request_stop(&mut run, "blocked", reason);
                }
            } else {
                let (node_id, session_id) = lost[0].clone();
                let reason = format!(
                    "节点 {} 的 Worker 已与 daemon 失联，尚未提交结果；原 Session 与写租约仍保留，交回 PM 核对后续接",
                    lost.iter()
                        .map(|(id, _)| id.as_str())
                        .collect::<Vec<_>>()
                        .join("、")
                );
                for (id, _) in &lost {
                    run.nodes.get_mut(id).expect("lost node").status = "interrupted".into();
                }
                run.recovery = Some(Recovery {
                    node_id,
                    previous_session_id: session_id,
                    waiting_since_ms: now_ms(),
                    reuse_session: true,
                    nodes: lost
                        .into_iter()
                        .map(|(node_id, session_id)| RecoveryNode {
                            node_id,
                            session_id,
                        })
                        .collect(),
                });
                run.status = "recoverable".into();
                run.stop = Some(StopRequest {
                    target: "recoverable".into(),
                    reason,
                    cause_code: "workerLost".into(),
                    actor: "patrol".into(),
                    cleanup_error: None,
                });
                if let Some(executor) = run.executor_session_id.clone() {
                    let message = flow_message(
                        &run,
                        "run.recoverable",
                        None,
                        &executor,
                        &run.parent_session_id,
                        Some(run.revision.saturating_add(1)),
                        serde_json::json!({"reuseSession": true, "status": "recoverable"}),
                    )?;
                    push_flow_message(&mut run, message);
                }
            }
        }
        if previous_status != run.status {
            run.revision += 1;
            run.updated_at_ms = now_ms();
            run.journal_actor = "patrol".into();
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
    let mut errors = Vec::new();
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
    if !matches!(current.status.as_str(), "stopping" | "cancelling") {
        return Ok(());
    }
    let stop = current
        .stop
        .clone()
        .ok_or_else(|| anyhow!("stopping Run has no durable stop decision"))?;
    if errors.is_empty() {
        for (id, node) in &mut current.nodes {
            match node.status.as_str() {
                "running" | "finishing" => {
                    node.status = if stop.target == "recoverable"
                        && current
                            .recovery
                            .as_ref()
                            .is_some_and(|recovery| recovery.node_id == *id)
                    {
                        "interrupted"
                    } else if stop.target == "cancelled" {
                        "cancelled"
                    } else {
                        "blocked"
                    }
                    .into()
                }
                "pending" if stop.target != "recoverable" => node.status = "unreached".into(),
                _ => {}
            }
        }
        if stop.target != "recoverable" {
            structured::retired(&mut current)?;
        }
        current.status = stop.target.clone();
        if stop.target == "recoverable" {
            current
                .recovery
                .as_mut()
                .expect("recoverable operation")
                .waiting_since_ms = now_ms();
        } else {
            current.recovery = None;
        }
        current.leases.clear();
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
