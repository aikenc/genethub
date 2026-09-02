//! Project Workflow commands exposed through the same production `genet` CLI
//! every Agent session receives.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use genehub_proto::{Reply, Request, WorkflowRunStatus};
use serde_json::json;

use super::output::{self, CliFailure};
use super::rpc::Rpc;
use super::target::Selection;
use super::{converse, query, EXIT_FAILED, EXIT_OK};

#[derive(Debug)]
enum Command {
    Init {
        agent_id: String,
        model_id: Option<String>,
    },
    Inspect {
        workspace_id: Option<String>,
    },
    Dispatch {
        workspace_id: Option<String>,
        workflow_id: Option<String>,
        kind: Option<String>,
        complexity: Option<String>,
        task_id: String,
        prompt: String,
        wait: bool,
        timeout: Option<u64>,
    },
    Get {
        workspace_id: Option<String>,
        run_id: Option<String>,
    },
    Complete {
        workspace_id: Option<String>,
        run_id: Option<String>,
        node_id: Option<String>,
        revision: Option<u64>,
        evidence: BTreeMap<String, String>,
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
    if let Command::Init { agent_id, model_id } = command {
        if let Err(error) = authorize_init().await {
            return output::fail(error);
        }
        let root = super::caller_cwd();
        return match crate::workflow::initialize_project(&root, &agent_id, model_id.as_deref()) {
            Ok(source) => {
                output::succeed(
                    "workflow.initialized",
                    json!({"root": source, "agentId": agent_id, "modelId": model_id}),
                );
                EXIT_OK
            }
            Err(error) => output::fail(CliFailure::business(
                "workflowInitFailed",
                format!("{error:#}"),
                None,
            )),
        };
    }

    let rpc = match query::connect_selected(selection).await {
        Ok(rpc) => rpc,
        Err(error) => return output::fail(error),
    };
    match execute(&rpc, command).await {
        Ok(code) => code,
        Err(error) => output::fail(error),
    }
}

async fn authorize_init() -> Result<(), CliFailure> {
    match super::caller_principal() {
        crate::authz::Principal::LocalUser => Ok(()),
        crate::authz::Principal::SessionController { session_id } => {
            let state = super::local_state().map_err(|message| {
                CliFailure::business("workflowInitUnavailable", message, None)
            })?;
            let summary = state.sessions.summary(&session_id).await.map_err(|error| {
                CliFailure::business(
                    "workflowInitUnauthorized",
                    format!("无法确认入口会话：{error:#}"),
                    None,
                )
            })?;
            if summary.managed.is_some() {
                return Err(CliFailure::business(
                    "workflowInitUnauthorized",
                    "受管子会话不能初始化或改写项目 Workflow；请回到根会话操作",
                    None,
                ));
            }
            Ok(())
        }
        _ => Err(CliFailure::business(
            "workflowInitUnauthorized",
            "只有本机用户或根普通会话可以初始化项目 Workflow",
            None,
        )),
    }
}

async fn execute(rpc: &Rpc, command: Command) -> Result<i32, CliFailure> {
    match command {
        Command::Init { .. } => unreachable!("handled before connecting"),
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
        Command::Complete {
            workspace_id,
            run_id,
            node_id,
            revision,
            evidence,
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
            let revision = match revision {
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
            let Reply::WorkflowRun(run) = rpc
                .call(Request::WorkflowComplete {
                    workspace_id,
                    run_id,
                    node_id,
                    expected_revision: revision,
                    evidence,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered workflow.complete with the wrong reply",
                ));
            };
            output::succeed("workflow.completed", serde_json::to_value(run).unwrap());
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
    Ok(summary.managed.map(|managed| ManagedBinding {
        workspace_id: summary.workspace_id,
        run_id: managed.workflow_run_id,
        node_id: managed.node_id,
    }))
}

fn active_sessions(run: &WorkflowRunStatus) -> Result<Vec<String>, CliFailure> {
    let sessions = run
        .nodes
        .iter()
        .filter(|node| node.status == "running")
        .filter_map(|node| node.session_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if sessions.is_empty() {
        Err({
            CliFailure::business(
                "workflowHasNoActiveSession",
                "Workflow 没有可等待的 Agent Session",
                Some(json!({"runId": run.id, "status": run.status})),
            )
        })
    } else {
        Ok(sessions)
    }
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
    let mut waited = BTreeSet::new();
    let mut workers_ok = true;
    while current.status == "running" {
        let active = active_sessions(&current)?;
        let mut found_new = false;
        for session_id in active {
            if !waited.insert(session_id.clone()) {
                continue;
            }
            found_new = true;
            let remaining = remaining_timeout(deadline)?;
            if converse::wait_for_existing(rpc, &session_id, remaining).await? != EXIT_OK {
                workers_ok = false;
                break;
            }
        }
        current = read_run(rpc, workspace_id, &current.id).await?;
        if !workers_ok || current.status != "running" {
            break;
        }
        if !found_new {
            return Err(CliFailure::business(
                "workflowNodeDidNotComplete",
                "Agent Session 已终态，但对应 Workflow 节点仍在运行；检查节点完成证据",
                Some(json!({"runId": current.id, "activeNodes": current.active_nodes})),
            ));
        }
    }
    Ok((current, workers_ok))
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

async fn resolve_workspace(rpc: &Rpc, explicit: Option<String>) -> Result<String, CliFailure> {
    if let Some(workspace_id) = explicit {
        let known = query::list_workspaces(rpc).await?;
        if known.iter().any(|workspace| workspace.id == workspace_id) {
            return Ok(workspace_id);
        }
        return Err(CliFailure::target_not_found("workspace", &workspace_id));
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
            agent_id: values.agent.take().unwrap_or_else(|| "opencode".into()),
            model_id: values
                .model
                .take()
                .or_else(|| Some("bailian-token-plan-personal/qwen3.8-flash".into())),
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
        "get" => Ok(Command::Get {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
        }),
        "complete" => Ok(Command::Complete {
            workspace_id: values.workspace.take(),
            run_id: values.run.take(),
            node_id: values.node.take(),
            revision: values.revision,
            evidence: values.evidence,
        }),
        _ => Err(CliFailure::invalid_args(
            "usage: genet workflow init|inspect|dispatch|get|complete ...",
        )),
    }
}

#[derive(Default)]
struct Values {
    positionals: Vec<String>,
    agent: Option<String>,
    model: Option<String>,
    workspace: Option<String>,
    workflow: Option<String>,
    kind: Option<String>,
    complexity: Option<String>,
    task: Option<String>,
    run: Option<String>,
    node: Option<String>,
    revision: Option<u64>,
    timeout: Option<u64>,
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
                "--agent" => values.agent = Some(next(&mut index)?),
                "--model" => values.model = Some(next(&mut index)?),
                "--workspace" => values.workspace = Some(next(&mut index)?),
                "--workflow" => values.workflow = Some(next(&mut index)?),
                "--kind" => values.kind = Some(next(&mut index)?),
                "--complexity" => values.complexity = Some(next(&mut index)?),
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
        let Command::Init { agent_id, model_id } = command else {
            panic!("wrong command")
        };
        assert_eq!(agent_id, "opencode");
        assert_eq!(
            model_id.as_deref(),
            Some("bailian-token-plan-personal/qwen3.8-flash")
        );
    }

    #[test]
    fn wait_projection_keeps_every_distinct_running_session() {
        let run = WorkflowRunStatus {
            id: "wr_test".into(),
            workspace_id: "ws_test".into(),
            parent_session_id: "s_root".into(),
            workflow_id: "fanout".into(),
            bundle_digest: "digest".into(),
            task_id: "task".into(),
            status: "running".into(),
            revision: 1,
            active_nodes: vec!["one".into(), "two".into()],
            nodes: vec![
                genehub_proto::WorkflowNodeRunStatus {
                    id: "one".into(),
                    uses: "agent.session".into(),
                    status: "running".into(),
                    session_id: Some("s_one".into()),
                    evidence: BTreeMap::new(),
                },
                genehub_proto::WorkflowNodeRunStatus {
                    id: "two".into(),
                    uses: "agent.session".into(),
                    status: "running".into(),
                    session_id: Some("s_two".into()),
                    evidence: BTreeMap::new(),
                },
            ],
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        assert_eq!(active_sessions(&run).unwrap(), vec!["s_one", "s_two"]);
    }

    #[test]
    fn project_catalog_routes_the_two_typed_classification_axes() {
        let root = tempfile::tempdir().unwrap();
        crate::workflow::initialize_project(root.path(), "genet", Some("qwen3.8-flash")).unwrap();
        let project = crate::workflow::inspect(root.path()).unwrap();

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
