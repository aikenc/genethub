//! Read-only checker available to PM, engineering and restricted WR tools.
use super::*;
use genehub_proto::{SessionStatus, WorkflowCheckReport, WorkflowFinding};

pub(crate) async fn check(
    state: &Shared,
    workspace_id: &str,
    run_id: Option<&str>,
    draft: bool,
) -> Result<WorkflowCheckReport> {
    let workspace = state.workspaces.get(workspace_id).await?;
    if draft {
        if run_id.is_some() {
            bail!("workflow check: --draft and --run are mutually exclusive");
        }
        return Ok(WorkflowCheckReport {
            checked_at_ms: now_ms(),
            findings: Vec::new(),
            runs: Vec::new(),
            draft: Some(authoring::check_draft(&workspace.root, &state.registry)),
        });
    }
    let runtime = RuntimeStore::new(&state.paths.root, workspace_id, &workspace.root)?;
    let all = all_runs(&runtime)?;
    let runs = if let Some(id) = run_id {
        vec![load_run(&runtime, id)?]
    } else {
        all.clone()
    };
    let mut report = WorkflowCheckReport {
        checked_at_ms: now_ms(),
        findings: Vec::new(),
        runs: Vec::new(),
        draft: None,
    };
    for run in runs {
        let mut finding = |node_id: Option<String>, code: &str, severity: &str, detail: String| {
            report.findings.push(WorkflowFinding {
                run_id: run.id.clone(),
                node_id,
                code: code.into(),
                severity: severity.into(),
                detail,
            });
        };
        if let Some(recovery) = &run.recovery {
            if run.status == "recoverable" {
                if recovery.reuse_session {
                    finding(Some(recovery.node_id.clone()), "recoverableOperation", "warning",
                        format!("未交卷 Worker Session {} 仍保留；核对 git 状态与潜在副作用后，可用 workflow recover --run {} --revision {} 通知同一 Worker 继续。已通过节点不会重跑，写租约不会释放。", recovery.previous_session_id, run.id, run.revision));
                } else {
                    finding(Some(recovery.node_id.clone()), "recoverableOperation", "warning",
                        format!("旧 Worker Session {} 已封禁并关闭；核对潜在副作用和预算后，可用 workflow recover --run {} --revision {} 在同一 Run 重试这个无写租约操作；不会重跑已完成节点。", recovery.previous_session_id, run.id, run.revision));
                }
            }
        }
        let definitions = if run.engine.is_some() {
            run.nodes
                .keys()
                .map(|id| runtime_node(&run, id))
                .collect::<Result<Vec<_>>>()?
        } else {
            run.definition.nodes.clone()
        };
        for node in &definitions {
            if node.uses != "agent.session" {
                continue;
            }
            let fallback = ["changesRequested", "failed", "blocked"]
                .into_iter()
                .filter(|event| !node.on.contains_key(*event))
                .collect::<Vec<_>>();
            if run.engine.is_none() && !fallback.is_empty() {
                finding(
                    Some(node.id.clone()),
                    "defaultBlockedExit",
                    "info",
                    format!(
                        "{} 未配置业务后续边；框架提供默认受阻出口；后续处理由项目工作流与任务负责人决定",
                        fallback.join(", ")
                    ),
                );
            }
            let Some(record) = run.nodes.get(&node.id) else {
                finding(
                    Some(node.id.clone()),
                    "missingNodeRecord",
                    "error",
                    "定义节点缺少运行记录".into(),
                );
                continue;
            };
            if record.status == "finishing" {
                finding(
                    Some(node.id.clone()),
                    "nodeFinishing",
                    "info",
                    "节点结果已持久化，正在确认执行及进程收尾；成功后按定义激活后续节点。".into(),
                );
            }
            if record.status == "running" {
                match &record.session_id {
                    None => finding(
                        Some(node.id.clone()),
                        "unassigned",
                        "warning",
                        "节点待派发；静默检测仍覆盖该节点".into(),
                    ),
                    Some(id) => {
                        let summary = state.sessions.summary(id).await;
                        if summary
                            .as_ref()
                            .is_ok_and(|session| session.status == SessionStatus::Waiting)
                        {
                            let requests = state
                                .sessions
                                .pending_questions(id)
                                .await
                                .unwrap_or_default();
                            finding(
                                Some(node.id.clone()),
                                "humanWait",
                                "info",
                                format!("会话 {id} 有明确 Human 等待对象：{}；不作为活动静默故障。问题和审批保持原 requestId 与原交互权限。",
                                    requests.iter().map(|request| format!("{} ({})", request.id, request.title.chars().take(256).collect::<String>())).collect::<Vec<_>>().join("、")),
                            );
                        } else if !state.sessions.has_execution(id).await {
                            finding(
                                Some(node.id.clone()),
                                "workerWithoutResult",
                                "error",
                                "Worker 无执行归属，节点仍 running；需要状态对账".into(),
                            );
                        } else if now_ms()
                            - record
                                .activity
                                .last_at_ms
                                .max(record.assigned_at_ms)
                                .max(run.created_at_ms)
                            >= supervision::SILENCE_MS
                        {
                            finding(Some(node.id.clone()), "silentAttempt", "warning", "至少 180 秒无可观测 LLM／工具活动；需诊断，在途长工具不能据此判失败".into());
                        }
                    }
                }
                let missing = node
                    .completion
                    .all
                    .iter()
                    .filter(|requirement| !record.evidence.contains_key(&requirement.key))
                    .map(|requirement| requirement.key.as_str())
                    .collect::<Vec<_>>();
                if !missing.is_empty() {
                    finding(
                        Some(node.id.clone()),
                        "evidencePending",
                        "info",
                        format!(
                            "待提交证据：{}；声明包含功能不能替代固定产物的运行行为检查",
                            missing.join(", ")
                        ),
                    );
                }
            }
            if let Some(reason) = &record.reason {
                finding(
                    Some(node.id.clone()),
                    "nodeOutcome",
                    "warning",
                    reason.clone(),
                );
            }
        }
        let group = all
            .iter()
            .filter(|other| request::group_id(other) == request::group_id(&run))
            .collect::<Vec<_>>();
        let snapshot = request::observation(&all, &run, now_ms())?;
        let tokens = group
            .iter()
            .flat_map(|run| request::activities(run))
            .try_fold(0u64, |sum, activity| {
                activity.tokens.map(|tokens| sum.saturating_add(tokens))
            });
        let budget = &snapshot.budget;
        finding(None, "requestBudget", "info", format!("原请求 {}：{}/{} 次 Run；已观测 {}/{} 次 LLM 调用；token {}；执行耗时 {}/{} 毫秒；预算 revision {}（仅全 Run Human 等待免计时；观测不代表额度预留）", snapshot.request_run_id, snapshot.used_runs, budget.max_runs, snapshot.observed_llm_rounds, budget.max_llm_rounds, tokens.map(|tokens| tokens.to_string()).unwrap_or_else(|| "未知".into()), snapshot.execution_ms, budget.deadline_ms, budget.revision));
        if let Some(problem) = &run.supervision.finding {
            finding(None, "diagnosis", "warning", problem.clone());
        }
        if let Some(stop) = &run.stop {
            finding(
                None,
                "stop",
                if stop.cleanup_error.is_some() {
                    "error"
                } else {
                    "info"
                },
                format!(
                    "{}{}",
                    stop.reason,
                    stop.cleanup_error
                        .as_ref()
                        .map(|error| format!("；收尾待处理：{error}"))
                        .unwrap_or_default()
                ),
            );
        }
        report.runs.push(run_status(&runtime, &run)?);
    }
    Ok(report)
}
