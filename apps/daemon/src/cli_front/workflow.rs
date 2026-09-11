//! Project Workflow commands exposed through the same production `genet` CLI
//! every Agent session receives.

use std::collections::BTreeMap;
use std::time::Duration;

use genehub_proto::{Reply, Request, WorkflowRunStatus};
use serde_json::json;

use super::output::{self, CliFailure};
use super::rpc::Rpc;
use super::target::Selection;
use super::{query, EXIT_FAILED, EXIT_OK};

#[derive(Debug)]
enum Command {
    Init {
        workspace_id: Option<String>,
        agent_id: String,
        model_id: Option<String>,
    },
    Activate {
        workspace_id: Option<String>,
        candidate_digest: Option<String>,
        revision: Option<u64>,
    },
    Inspect {
        workspace_id: Option<String>,
    },
    Dispatch {
        retry_of: Option<String>,
        resume_cancelled: bool,
        candidate_digest: Option<String>,
        workspace_id: Option<String>,
        workflow_id: Option<String>,
        kind: Option<String>,
        complexity: Option<String>,
        task_id: String,
        prompt: String,
        wait: bool,
        timeout: Option<u64>,
    },
    Check {
        workspace_id: Option<String>,
        run_id: Option<String>,
    },
    Get {
        workspace_id: Option<String>,
        run_id: Option<String>,
    },
    History {
        workspace_id: Option<String>,
        limit: Option<u32>,
    },
    Complete {
        workspace_id: Option<String>,
        run_id: Option<String>,
        node_id: Option<String>,
        revision: Option<u64>,
        evidence: BTreeMap<String, String>,
        outcome: Option<genehub_proto::WorkflowNodeOutcome>,
        reason: Option<String>,
    },
    Cancel {
        workspace_id: Option<String>,
        run_id: String,
        revision: u64,
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
        Command::Init {
            workspace_id,
            agent_id,
            model_id,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowProject(project) = rpc
                .call(Request::WorkflowInitialize {
                    workspace_id,
                    agent_id,
                    model_id,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.initialize with the wrong reply",
                ));
            };
            output::succeed(
                "workflow.initialized",
                serde_json::to_value(project).unwrap(),
            );
            Ok(EXIT_OK)
        }
        Command::Activate {
            workspace_id,
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
        Command::Inspect { workspace_id } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowProject(project) = rpc
                .call(Request::WorkflowInspect { workspace_id })
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
            workflow_id,
            kind,
            complexity,
            task_id,
            prompt,
            wait,
            timeout,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowProject(project) = rpc
                .call(Request::WorkflowInspect {
                    workspace_id: workspace_id.clone(),
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.inspect with the wrong reply",
                ));
            };
            let workflow_id = select_workflow(&project, workflow_id, kind, complexity)?;
            let Reply::WorkflowRun(started) = rpc
                .call(Request::WorkflowDispatch {
                    retry_of,
                    resume_cancelled: Some(resume_cancelled),
                    candidate_digest,
                    workspace_id: workspace_id.clone(),
                    workflow_id,
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
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::WorkflowCheck(report) = rpc
                .call(Request::WorkflowCheck {
                    workspace_id,
                    run_id,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.check with the wrong reply",
                ));
            };
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
        Command::Complete {
            workspace_id,
            run_id,
            node_id,
            revision,
            evidence,
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
                        let Reply::WorkflowRun(current) = rpc.call(Request::WorkflowGet {
                            workspace_id: workspace_id.clone(), run_id: run_id.clone(),
                        }).await.map_err(query::rpc_error)? else {
                            return Err(CliFailure::protocol("the daemon answered workflow.get with the wrong reply"));
                        };
                        current.revision
                    }
                };
                match rpc.call(Request::WorkflowComplete {
                    workspace_id: workspace_id.clone(), run_id: run_id.clone(),
                    node_id: node_id.clone(), expected_revision,
                    evidence: evidence.clone(), outcome, reason: reason.clone(),
                }).await {
                    Ok(Reply::WorkflowRun(run)) => break run,
                    Ok(_) => return Err(CliFailure::protocol("the daemon answered workflow.complete with the wrong reply")),
                    Err(super::rpc::RpcError::Remote(ref error))
                        if revision.is_none() && attempt < 20
                            && (error.message.starts_with("Workflow revision 冲突：")
                                || error.message == "Workflow Run 正由另一个请求修改") => {
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
async fn session_project(state: &crate::state::Shared, summary: &genehub_proto::SessionSummary) -> Result<String,CliFailure> {
    let mut current = summary.clone();
    let mut seen = std::collections::BTreeSet::new();
    for _ in 0..32 {
        if !seen.insert(current.id.clone()) {break;}
        if let Some(managed) = &current.managed {
            current = state.sessions.summary(&managed.parent_session_id).await.map_err(|error|
                CliFailure::business("workflowBindingUnavailable",format!("无法读取流程归属会话：{error:#}"),None))?;
        } else {
            return state.workspaces.project_root(&current.workspace_id).await.map_err(|error|
                CliFailure::business("workflowBindingUnavailable",format!("无法解析流程所属项目：{error:#}"),None));
        }
    }
    Err(CliFailure::business("workflowBindingUnavailable","流程归属链无效或超过上限",None))
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
    let workspace_id = session_project(&state,&summary).await?;
    Ok(summary.managed.map(|managed| ManagedBinding {
        workspace_id,
        run_id: managed.workflow_run_id,
        node_id: managed.node_id,
    }))
}

fn select_workflow(
    project: &genehub_proto::WorkflowProjectStatus,
    explicit: Option<String>,
    kind: Option<String>,
    complexity: Option<String>,
) -> Result<String, CliFailure> {
    if let Some(explicit) = explicit {
        return Ok(explicit);
    }
    if kind.is_none() && complexity.is_none() {
        return Ok(project.default_workflow.clone());
    }
    let mut matches = project
        .workflows
        .iter()
        .filter_map(|workflow| {
            let kind_matches = workflow
                .match_kind
                .as_deref()
                .is_none_or(|expected| kind.as_deref() == Some(expected));
            let complexity_matches = workflow
                .match_complexity
                .as_deref()
                .is_none_or(|expected| complexity.as_deref() == Some(expected));
            (kind_matches && complexity_matches).then_some((
                usize::from(workflow.match_kind.is_some())
                    + usize::from(workflow.match_complexity.is_some()),
                workflow.id.clone(),
            ))
        })
        .collect::<Vec<_>>();
    let Some(best_score) = matches.iter().map(|(score, _)| *score).max() else {
        return Err(CliFailure::business(
            "workflowRouteNotFound",
            "项目 catalog 没有匹配该需求分类的 Workflow；请调整分类或项目配置",
            Some(json!({
                "kind": kind,
                "complexity": complexity,
                "available": project.workflows.iter().map(|workflow| &workflow.id).collect::<Vec<_>>(),
            })),
        ));
    };
    matches.retain(|(score, _)| *score == best_score);
    if matches.len() != 1 {
        return Err(CliFailure::business(
            "workflowRouteAmbiguous",
            "项目 catalog 中有多条同等匹配的 Workflow；请使用 --workflow 明确选择",
            Some(json!({
                "kind": kind,
                "complexity": complexity,
                "matches": matches.iter().map(|(_, id)| id).collect::<Vec<_>>(),
            })),
        ));
    }
    Ok(matches.pop().expect("exactly one route remained").1)
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
    while matches!(current.status.as_str(), "running" | "stopping" | "cancelling") {
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
        return session_project(&state,&summary).await;
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
    let verb = args.first().map(String::as_str).unwrap_or_default();
    let mut values = Values::parse(&args[1..])?;
    match verb {
        "init" => Ok(Command::Init {
            workspace_id: values.workspace.take(),
            agent_id: values.agent.take().unwrap_or_else(|| "opencode".into()),
            model_id: values
                .model
                .take()
                .or_else(|| Some("bailian-token-plan-personal/qwen3.8-flash".into())),
        }),
        "activate" => Ok(Command::Activate {
            workspace_id: values.workspace.take(),
            candidate_digest: values.candidate.take(),
            revision: values.revision,
        }),
        "inspect" => Ok(Command::Inspect {
            workspace_id: values.workspace.take(),
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
                workflow_id: values.workflow.take(),
                kind: values.kind.take(),
                complexity: values.complexity.take(),
                task_id: values
                    .task
                    .take()
                    .unwrap_or_else(|| format!("task_{}", uuid::Uuid::new_v4().simple())),
                prompt,
                wait: values.wait.unwrap_or(true),
                timeout: values.timeout,
            })
        }
        "check" => Ok(Command::Check { workspace_id: values.workspace.take(), run_id: values.run.take() }),
        "get" => Ok(Command::Get {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
        }),
        "history" => Ok(Command::History {
            workspace_id: values.workspace.take(),
            limit: values.limit,
        }),
        "complete" => Ok(Command::Complete {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
            node_id: values.node.take(),
            revision: values.revision,
            evidence: values.evidence,
            outcome: values.outcome,
            reason: values.reason,
        }),
        "cancel" => Ok(Command::Cancel {
            workspace_id: values.workspace.take(),
            run_id: values.run.take().ok_or_else(|| CliFailure::invalid_args("workflow cancel 需要 --run <id>"))?,
            revision: values.revision.ok_or_else(|| CliFailure::invalid_args("workflow cancel 需要 --revision <current>"))?,
        }),
        _ => Err(CliFailure::invalid_args(
            "usage: genet workflow init|inspect|activate|dispatch|get|history|check|complete|cancel ...",
        )),
    }
}

#[derive(Default)]
struct Values {
    retry_of: Option<String>,
    resume_cancelled: bool,
    outcome: Option<genehub_proto::WorkflowNodeOutcome>,
    reason: Option<String>,
    positionals: Vec<String>,
    agent: Option<String>,
    model: Option<String>,
    workspace: Option<String>,
    workflow: Option<String>,
    kind: Option<String>,
    complexity: Option<String>,
    candidate: Option<String>,
    task: Option<String>,
    run: Option<String>,
    node: Option<String>,
    revision: Option<u64>,
    timeout: Option<u64>,
    limit: Option<u32>,
    wait: Option<bool>,
    evidence: BTreeMap<String, String>,
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
                "--retry-of" => values.retry_of = Some(next(&mut index)?),
                "--resume-cancelled" => values.resume_cancelled = true,
                "--outcome" => {
                    values.outcome = Some(
                        serde_json::from_value(json!(next(&mut index)?)).map_err(|_| {
                            CliFailure::invalid_args(
                                "--outcome 使用 completed|changesRequested|failed|blocked",
                            )
                        })?,
                    );
                }
                "--reason" => values.reason = Some(next(&mut index)?),
                "--agent" => values.agent = Some(next(&mut index)?),
                "--model" => values.model = Some(next(&mut index)?),
                "--workspace" => values.workspace = Some(next(&mut index)?),
                "--workflow" => values.workflow = Some(next(&mut index)?),
                "--kind" => values.kind = Some(next(&mut index)?),
                "--complexity" => values.complexity = Some(next(&mut index)?),
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
                "--wait" => values.wait = Some(true),
                "--no-wait" => values.wait = Some(false),
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
    fn direct_dispatch_does_not_invent_review_or_approval_flags() {
        let command = parse(&[
            "dispatch".into(),
            "--workflow".into(),
            "direct-change".into(),
            "--task".into(),
            "small-fix".into(),
            "--kind".into(),
            "business".into(),
            "--complexity".into(),
            "simple".into(),
            "修复按钮".into(),
        ])
        .unwrap();
        let Command::Dispatch {
            workflow_id,
            kind,
            complexity,
            task_id,
            prompt,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(workflow_id.as_deref(), Some("direct-change"));
        assert_eq!(kind.as_deref(), Some("business"));
        assert_eq!(complexity.as_deref(), Some("simple"));
        assert_eq!(task_id, "small-fix");
        assert_eq!(prompt, "修复按钮");
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
    fn initializer_defaults_to_opencode_qwen() {
        let command = parse(&["init".into()]).unwrap();
        let Command::Init {
            workspace_id,
            agent_id,
            model_id,
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(workspace_id, None);
        assert_eq!(agent_id, "opencode");
        assert_eq!(
            model_id.as_deref(),
            Some("bailian-token-plan-personal/qwen3.8-flash")
        );
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
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(workspace_id, None);
        assert_eq!(candidate_digest.as_deref(), Some("sha256:abc"));
        assert_eq!(revision, Some(7));
    }

    #[test]
    fn project_catalog_routes_the_two_typed_classification_axes() {
        let root = tempfile::tempdir().unwrap();
        crate::workflow::initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let runtime =
            crate::workflow::RuntimeStore::new(root.path(), "workspace", root.path()).unwrap();
        let project = crate::workflow::inspect(root.path(), &runtime).unwrap();

        assert_eq!(
            select_workflow(
                &project,
                None,
                Some("business".into()),
                Some("simple".into()),
            )
            .unwrap(),
            "direct-change"
        );
        assert!(select_workflow(
            &project,
            None,
            Some("workflow".into()),
            Some("complex".into()),
        )
        .unwrap_err()
        .message
        .contains("没有匹配"));
        assert_eq!(
            select_workflow(
                &project,
                Some("manual-override".into()),
                Some("workflow".into()),
                Some("complex".into()),
            )
            .unwrap(),
            "manual-override"
        );
    }
}
