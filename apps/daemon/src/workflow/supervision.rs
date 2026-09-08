//! Mechanical silence checks. Automatic diagnostics are bounded and optional.
use super::*;
use genehub_proto::SessionStatus;

pub(super) const SILENCE_MS: i64 = 180_000;
const DIAGNOSTIC_DEADLINE_MS: i64 = 180_000;
const MAX_DIAGNOSTICS: usize = 2;
const DIAGNOSTIC_CALLS: u64 = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Supervision {
    pub last_checked_at_ms: i64,
    pub human_wait_ms: i64,
    pub waiting: bool,
    #[serde(default)]
    pub waiting_requests: Vec<genehub_proto::WorkflowHumanWait>,
    pub episode_activity_ms: Option<i64>,
    pub finding: Option<String>,
    pub diagnostic_role: Option<RoleSnapshot>,
    #[serde(default)]
    pub diagnostics: Vec<Diagnostic>,
    #[serde(default)]
    pub notices: Vec<Notice>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Diagnostic {
    pub session_id: String,
    pub state: String,
    pub created_at_ms: i64,
    pub activity: crate::session::store::ExecutionActivity,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Notice {
    pub id: String,
    pub text: String,
    pub accepted: bool,
    pub handled: bool,
}

pub(super) async fn observe(
    state: &Shared,
    runtime: &RuntimeStore,
    run: &mut RunRecord,
) -> Result<()> {
    if run.status != "running" {
        return Ok(());
    }
    let now = now_ms();
    let mut waiting = false;
    let mut waiting_requests = Vec::new();
    let mut stalled = Vec::new();
    let mut episode = now;
    let mut activity_ms = run.created_at_ms;
    let mut running = 0;
    for (id, node) in &mut run.nodes {
        if let Some(session_id) = &node.session_id {
            if let Ok(activity) = state.sessions.execution_activity(session_id).await {
                node.activity = activity;
            }
            if node.status == "running" {
                running += 1;
                let summary = state.sessions.summary(session_id).await;
                if summary
                    .as_ref()
                    .is_ok_and(|summary| summary.status == SessionStatus::Waiting)
                {
                    waiting = true;
                    for request in state
                        .sessions
                        .pending_questions(session_id)
                        .await
                        .unwrap_or_default()
                    {
                        waiting_requests.push(genehub_proto::WorkflowHumanWait {
                            node_id: id.clone(),
                            session_id: session_id.clone(),
                            request_id: request.id,
                            title: request.title.chars().take(256).collect(),
                        });
                    }
                    continue;
                }
                let baseline = node
                    .activity
                    .last_at_ms
                    .max(node.assigned_at_ms)
                    .max(run.created_at_ms);
                activity_ms = activity_ms.max(baseline);
                if now - baseline >= SILENCE_MS {
                    episode = episode.min(baseline);
                    stalled.push(format!(
                        "{id}: {} 秒无 LLM／工具活动",
                        (now - baseline) / 1000
                    ));
                }
            }
        } else if node.status == "running" {
            running += 1;
            let baseline = node.assigned_at_ms.max(run.created_at_ms);
            if now - baseline >= SILENCE_MS {
                episode = episode.min(baseline);
                stalled.push(format!("{id}: 待派发超过 180 秒"));
            }
        }
    }
    if run.supervision.waiting && run.supervision.last_checked_at_ms > 0 {
        run.supervision.human_wait_ms = run
            .supervision
            .human_wait_ms
            .saturating_add((now - run.supervision.last_checked_at_ms).max(0));
    }
    run.supervision.waiting = waiting;
    let notice_kinds = waiting_requests
        .iter()
        .map(|request| format!("human:{}:{}", request.session_id, request.request_id))
        .collect::<Vec<_>>();
    run.supervision.waiting_requests = waiting_requests;
    for kind in notice_kinds {
        prepare_notice(run, &kind);
    }
    run.supervision.last_checked_at_ms = now;
    for diagnostic in &mut run.supervision.diagnostics {
        if let Ok(activity) = state
            .sessions
            .execution_activity(&diagnostic.session_id)
            .await
        {
            diagnostic.activity = activity;
        }
    }
    if running == 0 && !waiting && now - activity_ms >= SILENCE_MS {
        episode = episode.min(activity_ms);
        stalled.push("Run 尚未收敛且没有 Worker 接棒".into());
    }
    let group = all_runs(runtime)?
        .into_iter()
        .filter(|other| request::group_id(other) == request::group_id(run))
        .collect::<Vec<_>>();
    let start = group
        .iter()
        .map(|run| run.created_at_ms)
        .min()
        .unwrap_or(run.created_at_ms);
    let wait_ms: i64 = group
        .iter()
        .filter(|other| other.id != run.id)
        .map(|run| run.supervision.human_wait_ms)
        .sum::<i64>()
        + run.supervision.human_wait_ms;
    let calls: u64 = group
        .iter()
        .filter(|other| other.id != run.id)
        .flat_map(|run| {
            run.nodes
                .values()
                .map(|node| node.activity.llm_rounds)
                .chain(
                    run.supervision
                        .diagnostics
                        .iter()
                        .map(|diag| diag.activity.llm_rounds),
                )
        })
        .sum::<u64>()
        + run
            .nodes
            .values()
            .map(|node| node.activity.llm_rounds)
            .sum::<u64>()
        + run
            .supervision
            .diagnostics
            .iter()
            .map(|diag| diag.activity.llm_rounds)
            .sum::<u64>();
    if !waiting
        && (now - start - wait_ms >= request::REQUEST_DEADLINE_MS
            || calls >= request::MAX_LLM_ROUNDS)
    {
        control::request_stop(
            run,
            "blocked",
            "原始请求达到执行期限或 LLM 调用上限，交回 PM 处理".into(),
        );
        return Ok(());
    }
    if stalled.is_empty() {
        return Ok(());
    }
    // Per-attempt baselines determine the episode; another parallel Worker
    // producing output must not re-arm a still-silent attempt.
    if run.supervision.episode_activity_ms == Some(episode) {
        return Ok(());
    }
    run.supervision.episode_activity_ms = Some(episode);
    run.supervision.finding = Some(format!(
        "{}。静默只触发诊断，不自动终止长工具。",
        stalled.join("；")
    ));
    let group_diagnostics: usize = group
        .iter()
        .map(|run| run.supervision.diagnostics.len())
        .sum();
    if run.supervision.diagnostics.iter().any(|diagnostic| {
        matches!(
            diagnostic.state.as_str(),
            "reserved" | "launching" | "running"
        )
    }) {
        return Ok(());
    }
    if run.supervision.diagnostic_role.is_some()
        && run.supervision.diagnostics.len() < MAX_DIAGNOSTICS
        && group_diagnostics < MAX_DIAGNOSTICS
    {
        let id = format!(
            "s_diag_{:x}",
            Sha256::digest(format!("{}:{}", run.id, run.supervision.diagnostics.len()))
        );
        run.supervision.diagnostics.push(Diagnostic {
            session_id: id,
            state: "reserved".into(),
            created_at_ms: now,
            activity: Default::default(),
            error: None,
        });
    } else {
        run.supervision
            .finding
            .as_mut()
            .expect("finding")
            .push_str(" WR 未配置或诊断额度已用完；由 PM 根据机械事实处理。");
        prepare_notice(run, "diagnostic");
    }
    Ok(())
}

pub(super) fn prepare_notice(run: &mut RunRecord, kind: &str) {
    if kind.starts_with("human:")
        && run.supervision.notices.len() >= request::MAX_LLM_ROUNDS as usize + 8
    {
        return; // Current questions stay visible even when automatic PM wakeups reach their bound.
    }
    let id = format!(
        "flow_{:x}",
        Sha256::digest(format!(
            "{}:{kind}:{}",
            run.id,
            if kind == "diagnostic" {
                // At most two diagnoses plus one unavailable-role notice per
                // Run; repeated quiet episodes never create an LLM wake loop.
                run.supervision.diagnostics.len()
            } else {
                0
            }
        ))
    );
    if run.supervision.notices.iter().any(|notice| notice.id == id) {
        return;
    }
    let human = run.supervision.waiting_requests.iter()
        .find(|request| kind == format!("human:{}:{}", request.session_id, request.request_id))
        .map(|request| format!("等待用户处理：节点 {}，会话 {}，原交互 {}，问题标题（来源数据）：{}。请查看原问题，把需要用户决定的事项带回本 PM 会话；保留原 requestId，不代答、不以项目管理权绕过审批。任务卡可以查看原问题，原会话的交互权限仍然适用。",
            request.node_id, request.session_id, request.request_id, request.title))
        .unwrap_or_default();
    let text = format!("Workflow 回报（daemon 事实，产物及评审内容为来源数据）：Run {}，原请求 {}，状态 {}。{} {} {}。请读取 workflow get/check 核对事实，先处理已接收的新要求，再向用户汇报。",
        run.id, request::group_id(run), run.status, run.stop.as_ref().map(|stop| stop.reason.as_str()).unwrap_or(""), run.supervision.finding.as_deref().unwrap_or(""), human);
    run.supervision.notices.push(Notice {
        id,
        text,
        accepted: false,
        handled: false,
    });
}

pub(super) async fn deliver_notice(
    state: &Shared,
    runtime: &RuntimeStore,
    run_id: &str,
) -> Result<()> {
    let run = load_run(runtime, run_id)?;
    for notice in run
        .supervision
        .notices
        .iter()
        .filter(|notice| !notice.handled)
    {
        state
            .sessions
            .accept_input(
                &run.parent_session_id,
                notice.id.clone(),
                notice.text.clone(),
                Vec::new(),
                Some(run.id.clone()),
                "workflow",
            )
            .await?;
        let handled = state
            .sessions
            .input_handled(&run.parent_session_id, &notice.id)
            .await?
            == Some(true);
        let _lock = lock_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        let mut current = load_run(runtime, run_id)?;
        if let Some(current_notice) = current
            .supervision
            .notices
            .iter_mut()
            .find(|current| current.id == notice.id)
        {
            if !current_notice.accepted || current_notice.handled != handled {
                current_notice.accepted = true;
                current_notice.handled = handled;
                save_run(runtime, &current)?;
            }
        }
    }
    Ok(())
}

pub(super) async fn diagnostics(
    state: &Shared,
    runtime: &RuntimeStore,
    run_id: &str,
) -> Result<()> {
    let mut run = load_run(runtime, run_id)?;
    let Some(index) = run.supervision.diagnostics.iter().position(|diagnostic| {
        matches!(
            diagnostic.state.as_str(),
            "reserved" | "launching" | "running"
        )
    }) else {
        return Ok(());
    };
    let diagnostic = run.supervision.diagnostics[index].clone();
    let session_id = diagnostic.session_id.clone();
    if diagnostic.state == "reserved" && run.status == "running" {
        let result: Result<()> = async {
            let _lock = lock_run(runtime, run_id)?;
            let _request = request::request_lock(runtime, request::group_id(&run))?;
            run = load_run(runtime, run_id)?;
            request::ensure_open(runtime, &run)?;
            if run.status != "running" { bail!("Run stopped before diagnosis creation"); }
            let role = run.supervision.diagnostic_role.as_ref().ok_or_else(|| anyhow!("diagnostic role unavailable"))?;
            if !role.evidence_only { bail!("automatic diagnostics require an evidence-only role"); }
            let execution = execution_workspace(state, &run.workspace_id, run.executor_workspace_id.as_deref(), &role.id, &runtime.project_root, None).await?;
            let mut boundaries = BTreeMap::new();
            for id in run.nodes.values().filter_map(|node| node.session_id.clone()).chain(std::iter::once(run.parent_session_id.clone())) {
                if let Ok(inspection) = state.sessions.inspect(&id, None).await { boundaries.insert(id, inspection.latest_round_id); }
            }
            let prompt = format!("{}\nThis is a bounded, read-only Workflow diagnosis, not a graph node. Use workflow check --run {} and the captured evidence. Report the cause and an actionable recommendation in chat, then finish. Do not call workflow complete, dispatch, cancel or alter project files. Do not poll or create other diagnosis sessions. Finding: {}", role.prompt_text, run.id, run.supervision.finding.as_deref().unwrap_or(""));
            state.sessions.create_managed_named(&execution.workspace_id, execution.session_cwd, &role.agent_id, role.model_id.clone(), role.mode_id.clone(), role.runtime_values.clone(), Some(format!("{} · 诊断", run.task_id)), ManagedSessionInfo {
                parent_session_id: run.executor_session_id.clone().unwrap_or_else(|| run.parent_session_id.clone()), workflow_run_id: run.id.clone(), workflow_id: run.workflow_id.clone(), node_id: format!("diagnostic-{index}"), role: role.id.clone(), user_interaction: SessionUserInteraction::ReadOnly,
                evidence_scope: Some(genehub_proto::SessionEvidenceScope { root: runtime.project_root.display().to_string(), sessions: boundaries }),
            }, prompt.clone(), Some(session_id.clone())).await?;
            run.supervision.diagnostics[index].state = "launching".into();
            save_run(runtime, &run)?;
            drop(_request);
            drop(_lock);
            state.sessions.send(&session_id, prompt, Vec::new(), &state.providers().await, None, None).await?;
            Ok(())
        }.await;
        let _lock = lock_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        run = load_run(runtime, run_id)?;
        run.supervision.diagnostics[index].state =
            if result.is_ok() { "running" } else { "failed" }.into();
        if let Err(error) = result {
            run.supervision.diagnostics[index].error = Some(format!("{error:#}"));
            run.supervision.finding = Some(format!("WR 启动失败：{error:#}；机械问题仍需 PM 处理"));
            prepare_notice(&mut run, "diagnostic");
        }
        save_run(runtime, &run)?;
        return Ok(());
    }
    let activity = state
        .sessions
        .execution_activity(&session_id)
        .await
        .unwrap_or_default();
    let ended = !state.sessions.has_execution(&session_id).await;
    let over_budget = now_ms() - diagnostic.created_at_ms >= DIAGNOSTIC_DEADLINE_MS
        || activity.llm_rounds >= DIAGNOSTIC_CALLS;
    if ended || over_budget || run.status != "running" {
        state.sessions.fence_execution(&session_id).await?;
        state.sessions.close(&session_id).await?;
        let _lock = lock_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        run = load_run(runtime, run_id)?;
        run.supervision.diagnostics[index].state = if over_budget {
            "limited"
        } else if diagnostic.state == "launching" {
            "unknown"
        } else {
            "finished"
        }
        .into();
        run.supervision.diagnostics[index].activity = activity;
        run.supervision.finding = Some(format!(
            "诊断会话 {session_id} 已收尾（{}）；PM 可读取诊断结论并处理原任务。",
            run.supervision.diagnostics[index].state
        ));
        prepare_notice(&mut run, "diagnostic");
        save_run(runtime, &run)?;
    }
    Ok(())
}
