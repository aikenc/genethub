//! Project Workflow commands exposed through the same production `genet` CLI
//! every Agent session receives.

use std::collections::BTreeMap;
use std::time::Duration;

use genehub_proto::{Reply, Request, WorkflowRunStatus};
use serde_json::json;

use super::output::{self, CliFailure};
use super::rpc::{Rpc, RpcError};
use super::target::Selection;
use super::{query, EXIT_FAILED, EXIT_OK};

#[derive(Debug)]
enum Command {
    List {
        workspace_id: Option<String>,
    },
    Build {
        workspace_id: Option<String>,
        package_id: String,
        apply: bool,
        plan_digest: Option<String>,
        action_id: Option<String>,
        expected_revision: Option<u64>,
    },
    Activate {
        workspace_id: Option<String>,
        package_id: Option<String>,
        candidate_digest: Option<String>,
        revision: Option<u64>,
    },
    Inspect {
        workspace_id: Option<String>,
        package_id: Option<String>,
        candidate_digest: Option<String>,
    },
    Dispatch {
        retry_of: Option<String>,
        resume_cancelled: bool,
        candidate_digest: Option<String>,
        workspace_id: Option<String>,
        package_id: Option<String>,
        workflow_id: Option<String>,
        execution_root: Option<String>,
        task_id: String,
        prompt: String,
        wait: bool,
        timeout: Option<u64>,
    },
    Check {
        workspace_id: Option<String>,
        run_id: Option<String>,
        package_id: Option<String>,
        draft: bool,
    },
    Get {
        workspace_id: Option<String>,
        run_id: Option<String>,
    },
    History {
        workspace_id: Option<String>,
        limit: Option<u32>,
    },
    Journal {
        workspace_id: Option<String>,
        run_id: String,
        since: u64,
        limit: u32,
    },
    Complete {
        workspace_id: Option<String>,
        run_id: Option<String>,
        node_id: Option<String>,
        revision: Option<u64>,
        evidence: BTreeMap<String, String>,
        output: Option<serde_json::Value>,
        outcome: Option<genehub_proto::WorkflowNodeOutcome>,
        reason: Option<String>,
    },
    Cancel {
        workspace_id: Option<String>,
        run_id: String,
        revision: u64,
    },
    Recover {
        workspace_id: Option<String>,
        run_id: String,
        revision: u64,
    },
    RecoveryStart {
        workspace_id: Option<String>,
        run_id: String,
        reason: String,
    },
    Human {
        workspace_id: Option<String>,
        run_id: String,
        revision: u64,
        kind: String,
        reason: String,
    },
    RecoveryStatus {
        workspace_id: Option<String>,
        run_id: String,
    },
    RecoveryReset {
        workspace_id: Option<String>,
        package_id: Option<String>,
        revision: u64,
    },
    Budget {
        workspace_id: Option<String>,
        run_id: String,
        revision: u64,
        max_runs: Option<u32>,
        deadline_seconds: Option<u64>,
        max_llm_rounds: Option<u64>,
    },
}

pub async fn workflow(args: &[String], selection: &Selection) -> i32 {
    if selection.machine.is_some() {
        return output::fail(CliFailure::invalid_args(
            "workflow 命令只在当前根会话所在机器执行，不能使用 --machine",
        ));
    }
    let command = match parse(args) {
        Ok(command) => command,
        Err(error) => return output::fail(error),
    };
    let rpc = match query::connect_selected(selection).await {
        Ok(rpc) => rpc,
        Err(error) => return output::fail(error),
    };
    match execute(&rpc, command).await {
        Ok(code) => code,
        Err(error) => output::fail(error),
    }
}

async fn execute(rpc: &Rpc, command: Command) -> Result<i32, CliFailure> {
    match command {
        Command::List { workspace_id } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowPackages(list) = rpc
                .call(Request::WorkflowList { workspace_id })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.list with the wrong reply",
                ));
            };
            output::succeed("workflow.list", serde_json::to_value(list).unwrap());
            Ok(EXIT_OK)
        }
        Command::Build {
            workspace_id,
            package_id,
            apply,
            plan_digest,
            action_id,
            expected_revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let failure_plan_digest = plan_digest.clone();
            let Reply::WorkflowBuild(report) = rpc
                .call(Request::WorkflowBuild {
                    workspace_id,
                    package_id,
                    apply,
                    plan_digest,
                    action_id,
                    expected_revision,
                })
                .await
                .map_err(|error| build_rpc_error(error, failure_plan_digest.as_deref()))?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.build with the wrong reply",
                ));
            };
            output::succeed(
                if apply {
                    "workflow.built"
                } else {
                    "workflow.build.plan"
                },
                serde_json::to_value(report).unwrap(),
            );
            Ok(EXIT_OK)
        }
        Command::Activate {
            workspace_id,
            package_id,
            candidate_digest,
            revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let expected_revision = revision.ok_or_else(|| {
                CliFailure::invalid_args("workflow activate 需要 --revision <current>")
            })?;
            let Reply::WorkflowProject(project) = rpc
                .call(Request::WorkflowActivate {
                    workspace_id,
                    package_id,
                    candidate_digest,
                    expected_revision,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.activate with the wrong reply",
                ));
            };
            output::succeed("workflow.activated", serde_json::to_value(project).unwrap());
            Ok(EXIT_OK)
        }
        Command::Inspect {
            workspace_id,
            package_id,
            candidate_digest,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowProject(project) = rpc
                .call(Request::WorkflowInspect {
                    workspace_id,
                    package_id,
                    candidate_digest,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.inspect with the wrong reply",
                ));
            };
            output::succeed("workflow.inspect", serde_json::to_value(project).unwrap());
            Ok(EXIT_OK)
        }
        Command::Dispatch {
            retry_of,
            resume_cancelled,
            candidate_digest,
            workspace_id,
            package_id,
            workflow_id,
            execution_root,
            task_id,
            prompt,
            wait,
            timeout,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            // Package and flow selection are resolved by the daemon, which owns
            // the directory facts; the CLI stays a thin forwarder.
            let Reply::WorkflowRun(started) = rpc
                .call(Request::WorkflowDispatch {
                    retry_of,
                    resume_cancelled: Some(resume_cancelled),
                    candidate_digest,
                    workspace_id: workspace_id.clone(),
                    package_id,
                    workflow_id,
                    execution_root,
                    task_id,
                    prompt,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.dispatch with the wrong reply",
                ));
            };
            output::succeed("workflow.started", serde_json::to_value(&started).unwrap());
            if !wait {
                return Ok(EXIT_OK);
            }
            let (settled, workers_ok) = wait_for_run(rpc, &workspace_id, started, timeout).await?;
            output::succeed("workflow.result", serde_json::to_value(&settled).unwrap());
            Ok(if workers_ok && settled.status == "completed" {
                EXIT_OK
            } else {
                EXIT_FAILED
            })
        }
        Command::Check {
            workspace_id,
            run_id,
            package_id,
            draft,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowCheck(report) = rpc
                .call(Request::WorkflowCheck {
                    workspace_id,
                    run_id,
                    package_id,
                    draft: draft.then_some(true),
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.check with the wrong reply",
                ));
            };
            if draft && report.draft.is_none() {
                return Err(CliFailure::business(
                    "workflowValidationUnavailable",
                    "daemon 不支持草稿校验；更新同一环境后再试，不能用 Active 检查代替",
                    None,
                ));
            }
            if report.draft.as_ref().is_some_and(|d| !d.valid) {
                return Err(CliFailure::business(
                    "workflowValidationFailed",
                    "Workflow 草稿未通过校验；按 details.draft.diagnostics 修正后重试",
                    Some(serde_json::to_value(report).unwrap()),
                ));
            }
            output::succeed("workflow.check", serde_json::to_value(report).unwrap());
            Ok(EXIT_OK)
        }
        Command::Get {
            workspace_id,
            run_id,
        } => {
            let binding = binding_for_missing(workspace_id.is_none() || run_id.is_none()).await?;
            let workspace_id = resolve_workspace(
                rpc,
                workspace_id.or_else(|| binding.as_ref().map(|value| value.workspace_id.clone())),
            )
            .await?;
            let run_id = run_id
                .or_else(|| binding.map(|value| value.run_id))
                .ok_or_else(|| CliFailure::invalid_args("workflow get 需要 --run <id>"))?;
            let Reply::WorkflowRun(run) = rpc
                .call(Request::WorkflowGet {
                    workspace_id,
                    run_id,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.get with the wrong reply",
                ));
            };
            output::succeed("workflow.get", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::History {
            workspace_id,
            limit,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRuns(runs) = rpc
                .call(Request::WorkflowHistory {
                    workspace_id: workspace_id.clone(),
                    limit,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.history with the wrong reply",
                ));
            };
            output::succeed(
                "workflow.history",
                json!({"workspaceId": workspace_id, "runs": runs}),
            );
            Ok(EXIT_OK)
        }
        Command::Journal { workspace_id, run_id, since, limit } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowJournal(events) = rpc.call(Request::WorkflowJournal {
                workspace_id: workspace_id.clone(), run_id: run_id.clone(), since, limit,
            }).await.map_err(query::rpc_error)? else {
                return Err(CliFailure::protocol("the daemon answered workflow.journal with the wrong reply"));
            };
            output::succeed("workflow.journal", json!({"workspaceId": workspace_id, "runId": run_id, "events": events}));
            Ok(EXIT_OK)
        }
        Command::Complete {
            workspace_id,
            run_id,
            node_id,
            revision,
            evidence,
            output,
            outcome,
            reason,
        } => {
            let binding = binding_for_missing(
                workspace_id.is_none() || run_id.is_none() || node_id.is_none(),
            )
            .await?;
            let workspace_id = resolve_workspace(
                rpc,
                workspace_id.or_else(|| binding.as_ref().map(|value| value.workspace_id.clone())),
            )
            .await?;
            let run_id = run_id
                .or_else(|| binding.as_ref().map(|value| value.run_id.clone()))
                .ok_or_else(|| CliFailure::invalid_args("workflow complete 需要 --run <id>"))?;
            let node_id = node_id
                .or_else(|| binding.map(|value| value.node_id))
                .ok_or_else(|| CliFailure::invalid_args("workflow complete 需要 --node <id>"))?;
            // Automatic revision selection can race sibling completions. Retry only
            // definite pre-commit refusals, never transport/unknown-result failures.
            let mut attempt = 0;
            let run = loop {
                let expected_revision = match revision {
                    Some(revision) => revision,
                    None => {
                        let Reply::WorkflowRun(current) = rpc
                            .call(Request::WorkflowGet {
                                workspace_id: workspace_id.clone(),
                                run_id: run_id.clone(),
                            })
                            .await
                            .map_err(query::rpc_error)?
                        else {
                            return Err(CliFailure::protocol(
                                "the daemon answered workflow.get with the wrong reply",
                            ));
                        };
                        current.revision
                    }
                };
                match rpc
                    .call(Request::WorkflowComplete {
                        workspace_id: workspace_id.clone(),
                        run_id: run_id.clone(),
                        node_id: node_id.clone(),
                        expected_revision,
                        evidence: evidence.clone(),
                        output: output.clone(),
                        outcome: outcome.clone(),
                        reason: reason.clone(),
                    })
                    .await
                {
                    Ok(Reply::WorkflowRun(run)) => break run,
                    Ok(_) => {
                        return Err(CliFailure::protocol(
                            "the daemon answered workflow.complete with the wrong reply",
                        ))
                    }
                    Err(super::rpc::RpcError::Remote(ref error))
                        if revision.is_none()
                            && attempt < 20
                            && (error.message.starts_with("Workflow revision 冲突：")
                                || error.message == "Workflow Run 正由另一个请求修改") =>
                    {
                        attempt += 1;
                        tokio::time::sleep(Duration::from_millis(50)).await;
                    }
                    Err(error) => return Err(query::rpc_error(error)),
                }
            };
            output::succeed("workflow.completed", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::Cancel {
            workspace_id,
            run_id,
            revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc
                .call(Request::WorkflowCancel {
                    workspace_id,
                    run_id,
                    expected_revision: revision,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.cancel with the wrong reply",
                ));
            };
            output::succeed("workflow.cancelling", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::Recover {
            workspace_id,
            run_id,
            revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc
                .call(Request::WorkflowRecover {
                    workspace_id,
                    run_id,
                    expected_revision: revision,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.recover with the wrong reply",
                ));
            };
            output::succeed("workflow.recovered", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::RecoveryStart { workspace_id, run_id, reason } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc.call(Request::WorkflowRecoveryStart {
                workspace_id, run_id, reason,
            }).await.map_err(query::rpc_error)? else {
                return Err(CliFailure::protocol("the daemon answered workflow.recovery.start with the wrong reply"));
            };
            output::succeed("workflow.recovery.started", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::Human { workspace_id, run_id, revision, kind, reason } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc.call(Request::WorkflowHuman {
                workspace_id, run_id, expected_revision: revision, kind, reason,
            }).await.map_err(query::rpc_error)? else {
                return Err(CliFailure::protocol("the daemon answered workflow.human with the wrong reply"));
            };
            output::succeed("workflow.human.requested", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::RecoveryStatus { workspace_id, run_id } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc.call(Request::WorkflowGet {
                workspace_id, run_id,
            }).await.map_err(query::rpc_error)? else {
                return Err(CliFailure::protocol("the daemon answered workflow.recovery.status with the wrong reply"));
            };
            output::succeed("workflow.recovery.status", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
        Command::RecoveryReset { workspace_id, package_id, revision } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowProject(project) = rpc.call(Request::WorkflowRecoveryReset {
                workspace_id, package_id, expected_revision: revision,
            }).await.map_err(query::rpc_error)? else {
                return Err(CliFailure::protocol("the daemon answered workflow.recovery.reset with the wrong reply"));
            };
            output::succeed("workflow.recovery.reset", serde_json::to_value(project).unwrap());
            Ok(EXIT_OK)
        }
        Command::Budget {
            workspace_id,
            run_id,
            revision,
            max_runs,
            deadline_seconds,
            max_llm_rounds,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowRun(run) = rpc
                .call(Request::WorkflowBudget {
                    workspace_id,
                    run_id,
                    expected_revision: revision,
                    max_runs,
                    deadline_seconds,
                    max_llm_rounds,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.budget with the wrong reply",
                ));
            };
            output::succeed("workflow.budgetUpdated", serde_json::to_value(run).unwrap());
            Ok(EXIT_OK)
        }
    }
}

#[derive(Clone)]
struct ManagedBinding {
    workspace_id: String,
    run_id: String,
    node_id: String,
}

/// A managed activity may execute in a plain sub-workspace with no AgentSpace
/// parent. Its durable Session parent chain still identifies the owning project.
async fn session_project(
    state: &crate::state::Shared,
    summary: &genehub_proto::SessionSummary,
) -> Result<String, CliFailure> {
    let mut current = summary.clone();
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..32 {
        if !seen.insert(current.id.clone()) {
            break;
        }
        if let Some(managed) = &current.managed {
            current = state
                .sessions
                .summary(&managed.parent_session_id)
                .await
                .map_err(|error| {
                    CliFailure::business(
                        "workflowBindingUnavailable",
                        format!("无法读取流程归属会话：{error:#}"),
                        None,
                    )
                })?;
        } else {
            return state
                .workspaces
                .project_root(&current.workspace_id)
                .await
                .map_err(|error| {
                    CliFailure::business(
                        "workflowBindingUnavailable",
                        format!("无法解析流程所属项目：{error:#}"),
                        None,
                    )
                });
        }
    }
    Err(CliFailure::business(
        "workflowBindingUnavailable",
        "流程归属链无效或超过上限",
        None,
    ))
}

async fn binding_for_missing(needed: bool) -> Result<Option<ManagedBinding>, CliFailure> {
    if !needed {
        return Ok(None);
    }
    let crate::authz::Principal::SessionController { session_id } = super::caller_principal()
    else {
        return Ok(None);
    };
    let state = super::local_state()
        .map_err(|message| CliFailure::business("workflowBindingUnavailable", message, None))?;
    let summary = state.sessions.summary(&session_id).await.map_err(|error| {
        CliFailure::business(
            "workflowBindingUnavailable",
            format!("无法读取当前会话绑定：{error:#}"),
            None,
        )
    })?;
    let workspace_id = session_project(&state, &summary).await?;
    Ok(summary.managed.map(|managed| ManagedBinding {
        workspace_id,
        run_id: managed.workflow_run_id,
        node_id: managed.node_id,
    }))
}

/// Maps a `workflow build` failure to a stable machine-readable recovery
/// contract, so an Agent can tell "nothing happened, ask again" apart from
/// "the project changed and needs inspection" without parsing prose.
///
/// The old Pack installer's Git-preflight codes are gone with it: build never
/// initializes a repository or writes a commit, so the only stages left are
/// approval, materialization and registration.
fn build_rpc_error(error: RpcError, plan_digest: Option<&str>) -> CliFailure {
    let failure = query::rpc_error(error);
    let message = failure.message.clone();
    let known = [
        "builderVerifyFailed",
        "activationFailed",
        "revisionConflict",
        "activeRunConflict",
        "approvalRejected",
        "approvalStale",
        "approvalConsumed",
        "approvalRequired",
        "actionInProgress",
    ];
    let code = known
        .into_iter()
        .find(|candidate| message.contains(&format!("{candidate}:")))
        .unwrap_or(failure.code);
    let (stage, changed, retryable, recovery) = match code {
        "approvalRejected" => (
            "approval",
            false,
            false,
            "No changes were made. Ask again only if the user requests this package's team.",
        ),
        "approvalRequired" | "approvalStale" | "approvalConsumed" => (
            "approval",
            false,
            false,
            "Create a fresh `workflow build` plan and ask the user to approve that exact plan.",
        ),
        "actionInProgress" => (
            "approval",
            false,
            true,
            "Wait for the same action id to finish, then inspect its receipt.",
        ),
        "activeRunConflict" => (
            "preflight",
            false,
            true,
            "Finish or cancel the listed Runs, then plan the build again.",
        ),
        "builderVerifyFailed" => (
            "materialize",
            true,
            false,
            "Fix the reported package Space source or ownership conflict and plan again. Product directories are rebuildable; rerun the build after fixing the source.",
        ),
        "revisionConflict" => (
            "registryCommit",
            false,
            false,
            "Refresh the AgentSpace tree and create a new plan from the current revision.",
        ),
        "activationFailed" => (
            "workflowActivation",
            true,
            false,
            "Fix the package's flow source and plan again; `workflow check --draft` reports the exact diagnostic.",
        ),
        _ => (
            "request",
            false,
            failure.retryable,
            "Inspect the error and create a new plan after its cause is resolved.",
        ),
    };
    CliFailure {
        code,
        message,
        retryable,
        details: Some(json!({
            "schema": "genehub.workflow-build-failure.v1",
            "stage": stage,
            "code": code,
            "changed": changed,
            "retryable": retryable,
            "planDigest": plan_digest,
            "recoveryAction": recovery,
        })),
        exit: failure.exit,
    }
}

async fn wait_for_run(
    rpc: &Rpc,
    workspace_id: &str,
    started: WorkflowRunStatus,
    timeout_seconds: Option<u64>,
) -> Result<(WorkflowRunStatus, bool), CliFailure> {
    let deadline =
        timeout_seconds.map(|seconds| tokio::time::Instant::now() + Duration::from_secs(seconds));
    let mut current = started;
    // A Worker turn may finish before its Run commits cleanup or dispatches
    // the next node. Only the Run can decide its terminal outcome.
    while matches!(
        current.status.as_str(),
        "running" | "stopping" | "cancelling"
    ) {
        remaining_timeout(deadline)?;
        tokio::time::sleep(Duration::from_millis(250)).await;
        current = read_run(rpc, workspace_id, &current.id).await?;
    }
    let completed = current.status == "completed";
    Ok((current, completed))
}

fn remaining_timeout(deadline: Option<tokio::time::Instant>) -> Result<Option<u64>, CliFailure> {
    let Some(deadline) = deadline else {
        return Ok(None);
    };
    let now = tokio::time::Instant::now();
    if now >= deadline {
        return Err(CliFailure::business(
            "workflowWaitTimedOut",
            "等待 Workflow 完成超时",
            None,
        ));
    }
    let remaining = deadline.duration_since(now);
    Ok(Some(
        remaining
            .as_secs()
            .saturating_add(u64::from(remaining.subsec_nanos() > 0)),
    ))
}

async fn read_run(
    rpc: &Rpc,
    workspace_id: &str,
    run_id: &str,
) -> Result<WorkflowRunStatus, CliFailure> {
    let Reply::WorkflowRun(run) = rpc
        .call(Request::WorkflowGet {
            workspace_id: workspace_id.to_string(),
            run_id: run_id.to_string(),
        })
        .await
        .map_err(query::rpc_error)?
    else {
        return Err(CliFailure::protocol(
            "the daemon answered workflow.get with the wrong reply",
        ));
    };
    Ok(run)
}

/// Resolves which project a verb acts on: an explicit id must be open, and
/// otherwise the caller's working directory decides. Shared with `genet
/// space` so both surfaces answer "which project am I in" identically.
pub(super) async fn resolve_workspace(
    rpc: &Rpc,
    explicit: Option<String>,
) -> Result<String, CliFailure> {
    if let Some(workspace_id) = explicit {
        let known = query::list_workspaces(rpc).await?;
        if known.iter().any(|workspace| workspace.id == workspace_id) {
            return Ok(workspace_id);
        }
        return Err(CliFailure::target_not_found("workspace", &workspace_id));
    }
    // A Session's AgentSpace identity is stronger than cwd containment. A
    // Coder/Reviewer Space normally mounts the project root as an additional
    // folder, so cwd alone can match several siblings and accidentally choose
    // a child as the DCG entry. Walk the caller's ownership tree instead.
    if let crate::authz::Principal::SessionController { session_id } = super::caller_principal() {
        let state = super::local_state()
            .map_err(|message| CliFailure::business("workflowBindingUnavailable", message, None))?;
        let summary = state.sessions.summary(&session_id).await.map_err(|error| {
            CliFailure::business(
                "workflowBindingUnavailable",
                format!("无法读取当前会话：{error:#}"),
                None,
            )
        })?;
        return session_project(&state, &summary).await;
    }
    let cwd = super::caller_cwd();
    let known = query::list_workspaces(rpc).await?;
    super::place::deepest_containing(&known, &cwd, true)
        .map(|workspace| workspace.id.clone())
        .ok_or_else(|| {
            CliFailure::business(
                "targetNotFound",
                format!(
                    "当前目录 {} 不属于已打开的 Workspace；先在 GeneHub 打开该目录",
                    cwd.display()
                ),
                Some(json!({"cwd": cwd})),
            )
        })
}

fn parse(args: &[String]) -> Result<Command, CliFailure> {
    // The verb is read as an Option before the rest is sliced off: this parser
    // runs inside the daemon on behalf of a Session, so a bare `genet workflow`
    // that indexed past the end would take every session on the machine down
    // with it.
    let Some(verb) = args.first().map(String::as_str) else {
        return Err(CliFailure::invalid_args(USAGE));
    };
    let mut values = Values::parse(if verb == "recovery" { args.get(2..).unwrap_or(&[]) } else { &args[1..] })?;
    if values.draft && (verb != "check" || values.run.is_some()) {
        return Err(CliFailure::invalid_args(
            "--draft 只用于 workflow check，不能与 --run 同用",
        ));
    }
    match verb {
        "list" => Ok(Command::List {
            workspace_id: values.workspace.take(),
        }),
        "build" => Ok(Command::Build {
            workspace_id: values.workspace.take(),
            package_id: values.package.take().ok_or_else(|| {
                CliFailure::invalid_args("workflow build 需要 --package <id>")
            })?,
            apply: values.apply,
            plan_digest: values.plan_digest.take(),
            action_id: values.action_id.take(),
            expected_revision: values.revision,
        }),
        "activate" => Ok(Command::Activate {
            workspace_id: values.workspace.take(),
            package_id: values.package.take(),
            candidate_digest: values.candidate.take(),
            revision: values.revision,
        }),
        "inspect" => Ok(Command::Inspect {
            workspace_id: values.workspace.take(),
            package_id: values.package.take(),
            candidate_digest: values.candidate.take(),
        }),
        "dispatch" => {
            let prompt = values.positionals.join(" ").trim().to_string();
            if prompt.is_empty() {
                return Err(CliFailure::invalid_args(
                    "workflow dispatch 需要任务内容，可使用 --message <text>",
                ));
            }
            Ok(Command::Dispatch {
                retry_of: values.retry_of.take(),
                resume_cancelled: values.resume_cancelled,
                candidate_digest: values.candidate.take(),
                workspace_id: values.workspace.take(),
                package_id: values.package.take(),
                workflow_id: values.workflow.take(),
                execution_root: values.root.take(),
                task_id: values
                    .task
                    .take()
                    .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple())),
                prompt,
                wait: values.wait.unwrap_or(true),
                timeout: values.timeout,
            })
        }
        "check" => Ok(Command::Check { workspace_id: values.workspace.take(), run_id: values.run.take(), package_id: values.package.take(), draft: values.draft }),
        "get" => Ok(Command::Get {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
        }),
        "history" => Ok(Command::History {
            workspace_id: values.workspace.take(),
            limit: values.limit,
        }),
        "journal" => Ok(Command::Journal {
            workspace_id: values.workspace.take(),
            run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow journal 需要 --run <id>"))?,
            since: values.since.unwrap_or(0),
            limit: values.limit.unwrap_or(100).min(1024),
        }),
        "complete" => Ok(Command::Complete {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
            node_id: values.node.take(),
            revision: values.revision,
            evidence: values.evidence,
            output: values.output,
            outcome: values.outcome,
            reason: values.reason,
        }),
        "cancel" => Ok(Command::Cancel {
            workspace_id: values.workspace.take(),
            run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow cancel 需要 --run <id>"))?,
            revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow cancel 需要 --revision <current>"))?,
        }),
        "recover" | "continue" => Ok(Command::Recover {
            workspace_id: values.workspace.take(),
            run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow recover 需要 --run <id>"))?,
            revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow recover 需要 --revision <current>"))?,
        }),
        "human" => Ok(Command::Human {
            workspace_id: values.workspace.take(),
            run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow human 需要 --run <id>"))?,
            revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow human 需要 --revision <current>"))?,
            kind: values.kind.take().ok_or_else(|| CliFailure::invalid_args("workflow human 需要 --kind <a|b|c|d|e|f>"))?,
            reason: values.reason.take().filter(|reason| !reason.trim().is_empty())
                .ok_or_else(|| CliFailure::invalid_args("workflow human 需要 --reason <text>"))?,
        }),
        "recovery" => match args.get(1).map(String::as_str) {
            Some("start") => Ok(Command::RecoveryStart {
                workspace_id: values.workspace.take(),
                run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow recovery start 需要 --run <id>"))?,
                reason: values.reason.take().filter(|reason| !reason.trim().is_empty())
                    .ok_or_else(|| CliFailure::invalid_args("workflow recovery start 需要 --reason <text>"))?,
            }),
            Some("status") => Ok(Command::RecoveryStatus {
                workspace_id: values.workspace.take(),
                run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow recovery status 需要 --run <id>"))?,
            }),
            Some("check") => Ok(Command::Check {
                workspace_id: values.workspace.take(),
                run_id: None,
                package_id: values.package.take(),
                draft: true,
            }),
            Some("activate") => Ok(Command::Activate {
                workspace_id: values.workspace.take(),
                package_id: values.package.take(),
                candidate_digest: values.candidate.take(),
                revision: values.revision,
            }),
            Some("reset") => Ok(Command::RecoveryReset {
                workspace_id: values.workspace.take(),
                package_id: values.package.take(),
                revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow recovery reset 需要 --revision <current>"))?,
            }),
            _ => Err(CliFailure::invalid_args("usage: workflow recovery start|status|check|activate|reset ...")),
        },
        "budget" => {
            if values.max_runs.is_none()
                && values.deadline_seconds.is_none()
                && values.max_llm_rounds.is_none()
            {
                return Err(CliFailure::invalid_args(
                    "workflow budget 至少需要 --max-runs、--deadline-seconds 或 --max-llm-rounds",
                ));
            }
            Ok(Command::Budget {
                workspace_id: values.workspace.take(),
                run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow budget 需要 --run <id>"))?,
                revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow budget 需要 --revision <requestBudget.revision>"))?,
                max_runs: values.max_runs,
                deadline_seconds: values.deadline_seconds,
                max_llm_rounds: values.max_llm_rounds,
            })
        }
        _ => Err(CliFailure::invalid_args(USAGE)),
    }
}

const USAGE: &str =
    "usage: genet workflow list|build|inspect|activate|dispatch|get|history|journal|check|complete|cancel|recover|continue|recovery|human|budget ...";

#[derive(Default)]
struct Values {
    draft: bool,
    retry_of: Option<String>,
    resume_cancelled: bool,
    outcome: Option<genehub_proto::WorkflowNodeOutcome>,
    reason: Option<String>,
    kind: Option<String>,
    positionals: Vec<String>,
    workspace: Option<String>,
    package: Option<String>,
    workflow: Option<String>,
    root: Option<String>,
    candidate: Option<String>,
    apply: bool,
    plan_digest: Option<String>,
    action_id: Option<String>,
    task: Option<String>,
    run: Option<String>,
    node: Option<String>,
    revision: Option<u64>,
    timeout: Option<u64>,
    limit: Option<u32>,
    since: Option<u64>,
    max_runs: Option<u32>,
    deadline_seconds: Option<u64>,
    max_llm_rounds: Option<u64>,
    wait: Option<bool>,
    evidence: BTreeMap<String, String>,
    output: Option<serde_json::Value>,
}

impl Values {
    fn parse(args: &[String]) -> Result<Self, CliFailure> {
        let mut values = Self::default();
        let mut index = 0;
        while index < args.len() {
            let flag = args[index].as_str();
            let next = |index: &mut usize| -> Result<String, CliFailure> {
                *index += 1;
                args.get(*index)
                    .filter(|value| !value.trim().is_empty())
                    .cloned()
                    .ok_or_else(|| CliFailure::invalid_args(format!("{flag} 需要非空值")))
            };
            match flag {
                "--draft" => values.draft = true,
                "--retry-of" => values.retry_of = Some(next(&mut index)?),
                "--resume-cancelled" => values.resume_cancelled = true,
                "--outcome" => {
                    let value = next(&mut index)?;
                    if value.len() > 96 {
                        return Err(CliFailure::invalid_args("--outcome 名称不能超过 96 字符"));
                    }
                    values.outcome = Some(genehub_proto::WorkflowNodeOutcome(value));
                }
                "--reason" => values.reason = Some(next(&mut index)?),
                "--kind" => values.kind = Some(next(&mut index)?),

                "--workspace" => values.workspace = Some(next(&mut index)?),
                "--workflow" => values.workflow = Some(next(&mut index)?),
                "--package" => values.package = Some(next(&mut index)?),
                "--root" => values.root = Some(next(&mut index)?),
                "--apply" => values.apply = true,
                "--plan-digest" => values.plan_digest = Some(next(&mut index)?),
                "--action-id" => values.action_id = Some(next(&mut index)?),
                "--candidate" => values.candidate = Some(next(&mut index)?),
                "--task" => values.task = Some(next(&mut index)?),
                "--run" => values.run = Some(next(&mut index)?),
                "--node" => values.node = Some(next(&mut index)?),
                "--message" => values.positionals.push(next(&mut index)?),
                "--revision" => {
                    let value = next(&mut index)?;
                    values.revision = Some(
                        value
                            .parse()
                            .map_err(|_| CliFailure::invalid_args("--revision 需要非负整数"))?,
                    );
                }
                "--timeout" => {
                    let value = next(&mut index)?;
                    values.timeout = Some(
                        value
                            .parse()
                            .map_err(|_| CliFailure::invalid_args("--timeout 需要非负整数秒"))?,
                    );
                }
                "--limit" => {
                    let value = next(&mut index)?;
                    values.limit = Some(
                        value
                            .parse::<u32>()
                            .map_err(|_| CliFailure::invalid_args("--limit 需要正整数"))?,
                    );
                    if values.limit == Some(0) {
                        return Err(CliFailure::invalid_args("--limit 需要正整数"));
                    }
                }
                "--since" => {
                    values.since = Some(next(&mut index)?.parse::<u64>().map_err(|_| {
                        CliFailure::invalid_args("--since 需要非负日志序号")
                    })?);
                }
                "--max-runs" => {
                    let value = next(&mut index)?;
                    values.max_runs = Some(
                        value
                            .parse::<u32>()
                            .map_err(|_| CliFailure::invalid_args("--max-runs 需要正整数"))?,
                    );
                }
                "--deadline-seconds" => {
                    let value = next(&mut index)?;
                    values.deadline_seconds = Some(value.parse::<u64>().map_err(|_| {
                        CliFailure::invalid_args("--deadline-seconds 需要正整数秒")
                    })?);
                }
                "--max-llm-rounds" => {
                    let value = next(&mut index)?;
                    values.max_llm_rounds =
                        Some(value.parse::<u64>().map_err(|_| {
                            CliFailure::invalid_args("--max-llm-rounds 需要正整数")
                        })?);
                }
                "--wait" => values.wait = Some(true),
                "--no-wait" => values.wait = Some(false),
                "--output" => {
                    if values.output.is_some() {
                        return Err(CliFailure::invalid_args("--output 只能指定一次"));
                    }
                    let value = next(&mut index)?;
                    if value.len() > 256 * 1024 {
                        return Err(CliFailure::invalid_args("--output 超过 256 KiB"));
                    }
                    values.output = Some(serde_json::from_str(&value).map_err(|_| {
                        CliFailure::invalid_args("--output 需要有效 JSON（不是文件路径）")
                    })?);
                }
                "--evidence" => {
                    let value = next(&mut index)?;
                    let (key, value) = value.split_once('=').ok_or_else(|| {
                        CliFailure::invalid_args("--evidence 使用 key=value 格式")
                    })?;
                    if key.trim().is_empty() || value.trim().is_empty() {
                        return Err(CliFailure::invalid_args(
                            "--evidence 的 key 和 value 都不能为空",
                        ));
                    }
                    if values.evidence.insert(key.into(), value.into()).is_some() {
                        return Err(CliFailure::invalid_args(format!(
                            "重复 evidence key：{key}"
                        )));
                    }
                }
                other if other.starts_with('-') => {
                    return Err(CliFailure::invalid_args(format!("未知选项：{other}")))
                }
                other => values.positionals.push(other.into()),
            }
            index += 1;
        }
        Ok(values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workflow_command_with_no_verb_is_answered_instead_of_trapping() {
        let failure = parse(&[]).expect_err("a bare workflow command has no verb");
        assert!(failure.message.contains("usage: genet workflow"));
    }

    #[test]
    fn direct_dispatch_names_its_package_and_flow_without_inventing_routing_axes() {
        let command = parse(&[
            "dispatch".into(),
            "--package".into(),
            "studio/game-build".into(),
            "--workflow".into(),
            "direct-change".into(),
            "--task".into(),
            "small-fix".into(),
            "修复按钮".into(),
        ])
        .unwrap();
        let Command::Dispatch {
            package_id,
            workflow_id,
            task_id,
            prompt,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(package_id.as_deref(), Some("studio/game-build"));
        assert_eq!(workflow_id.as_deref(), Some("direct-change"));
        assert_eq!(task_id, "small-fix");
        assert_eq!(prompt, "修复按钮");
    }

    #[test]
    fn a_build_plan_and_its_apply_carry_the_same_explicit_package() {
        let Command::Build {
            package_id, apply, ..
        } = parse(&["build".into(), "--package".into(), "solo".into()]).unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(package_id, "solo");
        assert!(!apply, "a bare build is a plan, never a mutation");

        let Command::Build {
            package_id,
            apply,
            plan_digest,
            action_id,
            expected_revision,
            ..
        } = parse(&[
            "build".into(),
            "--package".into(),
            "solo".into(),
            "--apply".into(),
            "--plan-digest".into(),
            "sha256:plan".into(),
            "--action-id".into(),
            "act_1".into(),
            "--revision".into(),
            "3".into(),
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(package_id, "solo");
        assert!(apply);
        assert_eq!(plan_digest.as_deref(), Some("sha256:plan"));
        assert_eq!(action_id.as_deref(), Some("act_1"));
        assert_eq!(expected_revision, Some(3));

        assert!(
            parse(&["build".into()]).is_err(),
            "build must name the package it authorizes"
        );
    }

    #[test]
    fn completion_evidence_is_explicit_and_duplicate_keys_are_refused() {
        assert!(parse(&[
            "complete".into(),
            "--run".into(),
            "wr_1".into(),
            "--node".into(),
            "work".into(),
            "--revision".into(),
            "1".into(),
            "--evidence".into(),
            "checks=passed".into(),
            "--evidence".into(),
            "checks=again".into(),
        ])
        .is_err());
    }

    #[test]
    fn managed_worker_can_use_its_bound_run_node_and_latest_revision() {
        let command = parse(&[
            "complete".into(),
            "--evidence".into(),
            "commit=abc123".into(),
            "--evidence".into(),
            "checks=passed".into(),
        ])
        .unwrap();
        let Command::Complete {
            run_id,
            node_id,
            revision,
            evidence,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(run_id, None);
        assert_eq!(node_id, None);
        assert_eq!(revision, None);
        assert_eq!(evidence.get("commit").map(String::as_str), Some("abc123"));
        assert_eq!(evidence.get("checks").map(String::as_str), Some("passed"));
    }

    #[test]
    fn activation_requires_an_explicit_revision_and_accepts_rollback_identity() {
        let command = parse(&[
            "activate".into(),
            "--candidate".into(),
            "sha256:abc".into(),
            "--revision".into(),
            "7".into(),
        ])
        .unwrap();
        let Command::Activate {
            workspace_id,
            candidate_digest,
            revision,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(workspace_id, None);
        assert_eq!(candidate_digest.as_deref(), Some("sha256:abc"));
        assert_eq!(revision, Some(7));
    }

}
