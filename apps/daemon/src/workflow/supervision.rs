//! Mechanical Workflow progress checks and bounded PM notices.
use super::*;
use genehub_proto::SessionStatus;

pub(super) const NODE_WALL_MS: i64 = 180_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Supervision {
    pub last_checked_at_ms: i64,
    pub human_wait_ms: i64,
    #[serde(default)]
    pub recovery_wait_ms: i64,
    pub waiting: bool,
    #[serde(default)]
    pub waiting_requests: Vec<genehub_proto::WorkflowHumanWait>,
    #[serde(default)]
    pub notices: Vec<Notice>,
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
    let mut waiting_count = 0;
    let mut waiting_requests = Vec::new();
    let mut stalled = Vec::new();
    let mut activity_ms = run.created_at_ms;
    let mut running = 0;
    for (id, node) in &mut run.nodes {
        if let Some(session_id) = &node.session_id {
            if let Ok(activity) = state.sessions.execution_activity(session_id).await {
                node.activity = activity;
            }
        }
        // A completed node or a newly pending successor is progress too. An
        // old Run can briefly have no running Worker during a handoff; using
        // only its creation time would diagnose that gap immediately.
        activity_ms = activity_ms
            .max(node.pending_since_ms)
            .max(node.assigned_at_ms)
            .max(node.settled_at_ms)
            .max(node.activity.last_at_ms);
        if let Some(session_id) = &node.session_id {
            if node.status == "running" {
                running += 1;
                let summary = state.sessions.summary(session_id).await;
                if summary.as_ref().is_ok_and(|summary| summary.status == SessionStatus::Waiting) {
                    waiting_count += 1;
                    if !run.handles.is_empty() {
                        let answer_ms = run.definition.pm_answer_seconds
                            .unwrap_or(recovery::DEFAULT_PM_ANSWER_SECONDS)
                            .saturating_mul(1000).min(i64::MAX as u64) as i64;
                        if summary.as_ref().is_ok_and(|summary| now.saturating_sub(summary.updated_at_ms) >= answer_ms) {
                            stalled.push(format!("{id}: PM 作答超过 {} 秒期限", answer_ms / 1000));
                        }
                    }
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
                // A live Agent can legitimately spend several minutes in a
                // tool call. Its request budget and any declared activity
                // deadline still apply; wall time alone is not a failure.
            }
        } else if node.status == "running" {
            running += 1;
            let baseline = node.assigned_at_ms.max(run.created_at_ms);
            if now - baseline >= NODE_WALL_MS {
                stalled.push(format!("{id}: 待派发超过 180 秒"));
            }
        }
    }
    // Questions remain visible while siblings work. Only a wholly waiting Run
    // pauses its execution clock; pending dispatch and cleanup are still work.
    let waiting = waiting_count > 0
        && waiting_count == running
        && !run.nodes.values().any(|node| {
            node.status == "finishing" || (run.engine.is_some() && node.status == "pending")
        })
;
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
    if running == 0 && !waiting && now - activity_ms >= NODE_WALL_MS {
        stalled.push("Run 尚未收敛且没有 Worker 接棒".into());
    }
    if request::budget_exhausted(runtime, run, now)? {
        let (reason, cause) = if run.handles.is_empty() {
            ("requestBudgetExceeded: 原始请求达到执行期限或 LLM 调用上限，交回 PM 处理", "requestBudget")
        } else {
            ("recoveryBudgetExceeded: 恢复流程达到执行期限或 LLM 调用上限", "recoveryBudget")
        };
        control::request_stop_with_cause(
            run,
            "blocked",
            reason.into(),
            cause,
        );
        return Ok(());
    }
    if stalled.is_empty() {
        return Ok(());
    }
    control::request_stop_with_cause(run, "blocked", stalled.join("；"), "progressDeadline");
    Ok(())
}

pub(super) fn prepare_notice(run: &mut RunRecord, kind: &str) {
    // Cancellation is a control-plane result shown by task summaries. It does
    // not create a new conversation obligation (including legacy notices).
    if cancellation_requested(run) {
        return;
    }
    if kind.starts_with("human:")
        && run.supervision.notices.len()
            >= request::budget(run).max_llm_rounds.min(usize::MAX as u64) as usize + 8
    {
        return; // Current questions stay visible even when automatic PM wakeups reach their bound.
    }
    let id = format!("flow_{:x}", Sha256::digest(format!("{}:{kind}", run.id)));
    if run.supervision.notices.iter().any(|notice| notice.id == id) {
        return;
    }
    let human = run.supervision.waiting_requests.iter()
        .find(|request| kind == format!("human:{}:{}", request.session_id, request.request_id))
        .map(|request| format!("等待用户处理：节点 {}，会话 {}，原交互 {}，问题标题（来源数据）：{}。请查看原问题，把需要用户决定的事项带回本 PM 会话；保留原 requestId，不代答、不以项目管理权绕过审批。任务卡可以查看原问题，原会话的交互权限仍然适用。",
            request.node_id, request.session_id, request.request_id, request.title))
        .unwrap_or_default();
    let recovery = if run.status == "recoverable" {
        if run
            .recovery
            .as_ref()
            .is_some_and(|recovery| recovery.reuse_session)
        {
            "未交卷 Worker Session 仍保留，写租约未释放；核对工作区后可用 workflow recover --run <id> --revision <current> 通知同一 Worker 继续。已通过节点不会重跑。旧进程仍在运行时必须暂停，不能并行写入。"
        } else {
            "旧 Worker Session 已封禁并关闭；无写租约节点可由 PM 在核对潜在副作用与预算后用 workflow recover --run <id> --revision <current> 显式重试。无写租约不等于无外部副作用；本操作创建新 Worker 尝试，不保证副作用恰好一次，也不重开整张图。"
        }
    } else if matches!(run.status.as_str(), "blocked" | "failed") {
        "异常处置：本项目 PM 可直接管理流程与专家、取消或恢复任务，框架会逐次核对异常事实；不因原任务属于另一条 PM 会话而要求用户换会话。成功恢复或取消后回到正常权限。"
    } else {
        ""
    };
    let text = format!("Workflow 回报（daemon 事实，产物及评审内容为来源数据）：Run {}，原请求 {}，状态 {}。{} {}。{} 请读取 workflow get/check 核对事实，先处理已接收的新要求，再向用户汇报。",
        run.id, request::group_id(run), run.status, run.stop.as_ref().map(|stop| stop.reason.as_str()).unwrap_or(""), human, recovery);
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
    let ids = load_run(runtime, run_id)?
        .supervision
        .notices
        .into_iter()
        // Older builds could mark a notice handled while discarding it under
        // a cancelled predecessor. Reconsider only notices never accepted by
        // the recipient's inbox; accepted notices remain exactly-once.
        .filter(|notice| !notice.handled || !notice.accepted)
        .map(|notice| notice.id)
        .collect::<Vec<_>>();
    for id in ids {
        let _lock = lock_run(runtime, run_id)?;
        let mut run = load_run(runtime, run_id)?;
        let _request = request::request_lock(runtime, request::group_id(&run))?;
        let root = load_run(runtime, request::group_id(&run))?;
        let cancelled = cancellation_requested(&run) || request::cancelled(&root);
        let notice = run
            .supervision
            .notices
            .iter()
            .find(|notice| notice.id == id)
            .ok_or_else(|| anyhow!("Workflow notice disappeared"))?
            .clone();
        // Addressed to whoever owns this Run's notices now, not to whoever
        // dispatched it: the dispatching conversation may have been forked
        // away from or archived, and the inbox retires a notice it cannot
        // match rather than holding it.
        let recipient = super::notice_recipient(state, &run).await?;
        if cancelled {
            state
                .sessions
                .discard_workflow_inputs(&recipient, &run.id)
                .await?;
            for notice in &mut run.supervision.notices {
                notice.handled = true;
            }
            save_run(runtime, &run)?;
            return Ok(());
        }
        state
            .sessions
            .accept_input(
                &recipient,
                notice.id.clone(),
                notice.text.clone(),
                Vec::new(),
                Some(run.id.clone()),
                "workflow",
            )
            .await?;
        let handled = state
            .sessions
            .input_handled(&recipient, &notice.id)
            .await?
            == Some(true);
        if let Some(current_notice) = run
            .supervision
            .notices
            .iter_mut()
            .find(|current| current.id == notice.id)
        {
            if !current_notice.accepted || current_notice.handled != handled {
                current_notice.accepted = true;
                current_notice.handled = handled;
                save_run(runtime, &run)?;
            }
        }
    }
    Ok(())
}

pub(super) fn cancellation_requested(run: &RunRecord) -> bool {
    matches!(run.status.as_str(), "cancelling" | "cancelled")
        || run
            .request
            .as_ref()
            .is_some_and(|request| request.cancelled)
}

pub(super) fn report_pending(run: &RunRecord) -> bool {
    !cancellation_requested(run)
        && run
            .supervision
            .notices
            .iter()
            .any(|notice| !notice.handled || !notice.accepted)
}
