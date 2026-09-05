//! AgentSpace composition commands exposed through the same production
//! `genet` CLI every Agent session receives.
//!
//! These are the typed verbs a PM's Skill calls. Deliberately mechanical:
//! the daemon owns the invariants, and the methodology for *when* to mount a
//! component or grow a subteam belongs in the project's own Skill assets, not
//! in this parser.

use genehub_proto::{AgentSpaceBuilderOperation, AgentSpaceOperation, Reply, Request};
use serde_json::json;

use super::output::{self, CliFailure};
use super::rpc::{Rpc, RpcError};
use super::target::Selection;
use super::workflow::resolve_workspace;
use super::{query, EXIT_OK};

#[derive(Debug)]
enum Command {
    Inspect {
        workspace_id: Option<String>,
    },
    Children {
        workspace_id: Option<String>,
    },
    Configure {
        workspace_id: Option<String>,
        revision: Option<u64>,
        operation: AgentSpaceOperation,
        plan: bool,
        plan_digest: Option<String>,
        action_id: Option<String>,
    },
    Builder {
        workspace_id: Option<String>,
        space_name: String,
        operation: AgentSpaceBuilderOperation,
    },
    Bootstrap {
        workspace_id: Option<String>,
        pack_id: String,
        apply: bool,
        agent_id: Option<String>,
        model_id: Option<String>,
        plan_digest: Option<String>,
        action_id: Option<String>,
        expected_revision: Option<u64>,
    },
    RequestApproval {
        challenge_id: String,
    },
    BootstrapList,
}

pub async fn space(args: &[String], selection: &Selection) -> i32 {
    if selection.machine.is_some() {
        return output::fail(CliFailure::invalid_args(
            "space 命令只在当前根会话所在机器执行，不能使用 --machine",
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
        Command::Inspect { workspace_id } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let workspaces = query::list_workspaces(rpc).await?;
            let space = workspaces
                .into_iter()
                .find(|workspace| workspace.id == workspace_id)
                .ok_or_else(|| CliFailure::target_not_found("workspace", &workspace_id))?;
            output::succeed(
                "space.inspect",
                json!({
                    "workspaceId": space.id,
                    "name": space.name,
                    // Absent rather than empty: a folder that was never
                    // registered is a neutral filesystem fact, and saying
                    // "revision 0, no components" would read like a decision.
                    "agentSpace": space.agent_space,
                }),
            );
            Ok(EXIT_OK)
        }
        Command::Children { workspace_id } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::Workspaces(children) = rpc
                .call(Request::AgentSpaceChildren {
                    workspace_id: workspace_id.clone(),
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered agentSpace.children with the wrong reply",
                ));
            };
            output::succeed(
                "space.children",
                json!({
                    "workspaceId": workspace_id,
                    "children": children.iter().map(|child| json!({
                        "workspaceId": child.id,
                        "name": child.name,
                        "agentSpace": child.agent_space,
                    })).collect::<Vec<_>>(),
                }),
            );
            Ok(EXIT_OK)
        }
        Command::Configure {
            workspace_id,
            revision,
            operation,
            plan,
            plan_digest,
            action_id,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let expected_revision = match revision {
                Some(revision) => revision,
                // Reading the current revision here is a convenience for a
                // human at a terminal, not a way around the compare-and-set:
                // a script that must not lose a concurrent change passes
                // `--revision` explicitly.
                None => current_revision(rpc, &workspace_id).await?,
            };
            if plan {
                let Reply::AgentSpaceChangePlan(report) = rpc
                    .call(Request::AgentSpaceChangePlan {
                        workspace_id,
                        expected_revision,
                        operation,
                    })
                    .await
                    .map_err(query::rpc_error)?
                else {
                    return Err(CliFailure::protocol(
                        "the daemon answered agentSpace.changePlan with the wrong reply",
                    ));
                };
                output::succeed(
                    "space.change-plan",
                    serde_json::to_value(report).expect("AgentSpace plans serialize"),
                );
            } else {
                let Reply::Workspace(space) = rpc
                    .call(Request::AgentSpaceConfigure {
                        workspace_id,
                        expected_revision,
                        operation,
                        plan_digest,
                        action_id,
                    })
                    .await
                    .map_err(query::rpc_error)?
                else {
                    return Err(CliFailure::protocol(
                        "the daemon answered agentSpace.configure with the wrong reply",
                    ));
                };
                output::succeed(
                    "space.configured",
                    json!({
                        "workspaceId": space.id,
                        "agentSpace": space.agent_space,
                    }),
                );
            }
            Ok(EXIT_OK)
        }
        Command::Builder {
            workspace_id,
            space_name,
            operation,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::AgentSpaceBuilder(report) = rpc
                .call(Request::AgentSpaceBuilder {
                    workspace_id,
                    target_workspace_id: None,
                    space_name,
                    operation,
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered agentSpace.builder with the wrong reply",
                ));
            };
            output::succeed(
                "space.builder",
                serde_json::to_value(report).expect("Builder reports serialize"),
            );
            Ok(EXIT_OK)
        }
        Command::Bootstrap {
            workspace_id,
            pack_id,
            apply,
            agent_id,
            model_id,
            plan_digest,
            action_id,
            expected_revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let failure_plan_digest = plan_digest.clone();
            let Reply::BootstrapPack(report) = rpc
                .call(Request::ProjectBootstrap {
                    workspace_id,
                    pack_id,
                    apply,
                    agent_id,
                    model_id,
                    plan_digest,
                    action_id,
                    expected_revision,
                })
                .await
                .map_err(|error| bootstrap_rpc_error(error, failure_plan_digest.as_deref()))?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered project.bootstrap with the wrong reply",
                ));
            };
            output::succeed(
                "space.bootstrap",
                serde_json::to_value(report).expect("Bootstrap reports serialize"),
            );
            Ok(EXIT_OK)
        }
        Command::BootstrapList => {
            let Reply::BootstrapPacks(packs) = rpc
                .call(Request::BootstrapPackList)
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered project.bootstrap.list with the wrong reply",
                ));
            };
            output::succeed("space.bootstrap.list", json!({"packs": packs}));
            Ok(EXIT_OK)
        }
        Command::RequestApproval { challenge_id } => {
            let Reply::Ack = rpc
                .call(Request::ProjectApprovalRequest {
                    challenge_id: challenge_id.clone(),
                })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "the daemon answered project.approval.request with the wrong reply",
                ));
            };
            output::succeed(
                "space.approval.requested",
                json!({
                    "challengeId": challenge_id,
                    "approved": true,
                }),
            );
            Ok(EXIT_OK)
        }
    }
}

fn bootstrap_rpc_error(error: RpcError, plan_digest: Option<&str>) -> CliFailure {
    let failure = query::rpc_error(error);
    let message = failure.message.clone();
    let known = [
        "rollbackIncomplete",
        "builderVerifyFailed",
        "activationFailed",
        "revisionConflict",
        "approvalRejected",
        "approvalStale",
        "approvalConsumed",
        "approvalRequired",
        "actionInProgress",
        "wrongProjectRoot",
        "ancestorGitBoundary",
        "nonEmptyNonGit",
        "dirtyGit",
        "gitIdentityUnavailable",
        "packConflict",
        "bootstrapFailed",
    ];
    let code = known
        .into_iter()
        .find(|candidate| {
            message.starts_with(&format!("{candidate}:"))
                || message.contains(&format!("{candidate}:"))
        })
        .unwrap_or(failure.code);
    let (stage, changed, rolled_back, retryable, recovery) = match code {
        "approvalRejected" => (
            "approval",
            false,
            true,
            false,
            "No changes were made. Ask again only if the user requests takeover.",
        ),
        "approvalRequired" | "approvalStale" | "approvalConsumed" => (
            "approval",
            false,
            true,
            false,
            "Create a fresh read-only plan and ask the user to approve that exact plan.",
        ),
        "actionInProgress" => (
            "approval",
            false,
            true,
            true,
            "Wait for the same action id to finish, then inspect its receipt.",
        ),
        "wrongProjectRoot" | "ancestorGitBoundary" => (
            "gitPreflight",
            false,
            true,
            false,
            "Open the intended project root as its own Workspace and plan again.",
        ),
        "nonEmptyNonGit" => (
            "gitPreflight",
            false,
            true,
            false,
            "Use an empty folder, or initialize and commit this folder before takeover.",
        ),
        "dirtyGit" => (
            "gitPreflight",
            false,
            true,
            false,
            "Commit or clean the listed project changes, then create a new plan.",
        ),
        "gitIdentityUnavailable" => (
            "gitCommit",
            false,
            true,
            false,
            "Configure user.name and user.email, or use the product identity shown by a new plan.",
        ),
        "packConflict" => (
            "packPreflight",
            false,
            true,
            false,
            "Inspect the existing PM runtime and migrate or archive it before takeover.",
        ),
        "builderVerifyFailed" => (
            "builderVerify",
            true,
            true,
            false,
            "Fix the reported AgentSpaceBuilder source or ownership conflict and plan again.",
        ),
        "revisionConflict" => (
            "registryCommit",
            false,
            true,
            false,
            "Refresh the AgentSpace tree and create a new plan from the current revision.",
        ),
        "activationFailed" => (
            "workflowActivation",
            true,
            true,
            false,
            "Fix the Pack workflow source or evaluation failure and plan again.",
        ),
        "rollbackIncomplete" => (
            "rollback",
            true,
            false,
            false,
            "Do not start a Run. Inspect the transaction report and repair the listed residual objects.",
        ),
        "bootstrapFailed" => (
            "apply",
            true,
            true,
            true,
            "The transaction was rolled back. Resolve the reported cause and retry the same action or plan again.",
        ),
        _ => (
            "request",
            false,
            true,
            failure.retryable,
            "Inspect the error and create a new plan after its cause is resolved.",
        ),
    };
    CliFailure {
        code,
        message,
        retryable,
        details: Some(json!({
            "schema": "genehub.bootstrap-failure.v1",
            "stage": stage,
            "code": code,
            "changed": changed,
            "rolledBack": rolled_back,
            "retryable": retryable,
            "planDigest": plan_digest,
            "conflictObjects": [],
            "recoveryAction": recovery,
        })),
        exit: failure.exit,
    }
}

async fn current_revision(rpc: &Rpc, workspace_id: &str) -> Result<u64, CliFailure> {
    let workspaces = query::list_workspaces(rpc).await?;
    let space = workspaces
        .into_iter()
        .find(|workspace| workspace.id == workspace_id)
        .ok_or_else(|| CliFailure::target_not_found("workspace", workspace_id))?;
    Ok(space
        .agent_space
        .map(|space| space.revision)
        .unwrap_or_default())
}

fn parse(args: &[String]) -> Result<Command, CliFailure> {
    let verb = args.first().map(String::as_str).unwrap_or_default();
    let sub = args.get(1).map(String::as_str).unwrap_or_default();
    let rest = |from: usize| -> &[String] { args.get(from..).unwrap_or_default() };
    match (verb, sub) {
        ("inspect", _) => {
            let mut values = Values::parse(rest(1))?;
            Ok(Command::Inspect {
                workspace_id: values.workspace.take(),
            })
        }
        ("children", _) => {
            let mut values = Values::parse(rest(1))?;
            Ok(Command::Children {
                workspace_id: values.workspace.take(),
            })
        }
        ("component", "set") => {
            let mut values = Values::parse(rest(2))?;
            values.validate_change_mode()?;
            let component_id = values.component.take().ok_or_else(|| {
                CliFailure::invalid_args("space component set 需要 --component <pm|executor|worker|reviewer>")
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                plan: values.plan,
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                operation: AgentSpaceOperation::SetComponent {
                    component_id,
                    enabled: !values.disabled,
                    role: values.role.take(),
                },
            })
        }
        ("component", "remove") => {
            let mut values = Values::parse(rest(2))?;
            values.validate_change_mode()?;
            let component_id = values.component.take().ok_or_else(|| {
                CliFailure::invalid_args("space component remove 需要 --component <id>")
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                plan: values.plan,
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                operation: AgentSpaceOperation::RemoveComponent { component_id },
            })
        }
        ("parent", "set") => {
            let mut values = Values::parse(rest(2))?;
            values.validate_change_mode()?;
            if values.parent.is_some() && values.detach {
                return Err(CliFailure::invalid_args(
                    "space parent set 不能同时使用 --parent 与 --detach",
                ));
            }
            if values.parent.is_none() && !values.detach {
                return Err(CliFailure::invalid_args(
                    "space parent set 需要 --parent <id> 或 --detach",
                ));
            }
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                plan: values.plan,
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                operation: AgentSpaceOperation::SetParent {
                    parent_workspace_id: values.parent.take(),
                },
            })
        }
        ("lifecycle", "set") => {
            let mut values = Values::parse(rest(2))?;
            values.validate_change_mode()?;
            let lifecycle = values.lifecycle.take().ok_or_else(|| {
                CliFailure::invalid_args(
                    "space lifecycle set 需要 --lifecycle <persistent|pooled|ephemeral>",
                )
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                plan: values.plan,
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                operation: AgentSpaceOperation::SetLifecycle { lifecycle },
            })
        }
        ("builder", action) => {
            let mut values = Values::parse(rest(2))?;
            let space_name = values.name.take().ok_or_else(|| {
                CliFailure::invalid_args("space builder 需要 --name <agent-space>")
            })?;
            let operation = match action {
                "init" => AgentSpaceBuilderOperation::Init,
                "check" => AgentSpaceBuilderOperation::Check,
                "explain" => AgentSpaceBuilderOperation::Explain,
                "build" => AgentSpaceBuilderOperation::Build {
                    dry_run: values.dry_run,
                    require_no_post_commands: values.require_no_post_commands,
                },
                "verify" => AgentSpaceBuilderOperation::Verify,
                "clean" => AgentSpaceBuilderOperation::Clean,
                _ => {
                    return Err(CliFailure::invalid_args(
                        "usage: genet space builder init|check|explain|build|verify|clean --name <agent-space>",
                    ));
                }
            };
            if action != "build" && (values.dry_run || values.require_no_post_commands) {
                return Err(CliFailure::invalid_args(
                    "--dry-run 与 --require-no-post-commands 只用于 space builder build",
                ));
            }
            Ok(Command::Builder {
                workspace_id: values.workspace.take(),
                space_name,
                operation,
            })
        }
        ("bootstrap", "list") => {
            if !rest(2).is_empty() {
                return Err(CliFailure::invalid_args(
                    "space bootstrap list 不接受额外参数",
                ));
            }
            Ok(Command::BootstrapList)
        }
        ("approval", "request") => {
            let mut values = Values::parse(rest(2))?;
            let challenge_id = values.challenge.take().ok_or_else(|| {
                CliFailure::invalid_args("space approval request 需要 --challenge <id>")
            })?;
            Ok(Command::RequestApproval { challenge_id })
        }
        ("bootstrap", action @ ("plan" | "apply")) => {
            let mut values = Values::parse(rest(2))?;
            let pack_id = values.pack.take().ok_or_else(|| {
                CliFailure::invalid_args("space bootstrap 需要 --pack <id>")
            })?;
            let apply = action == "apply";
            if apply
                && (values.plan_digest.is_none()
                    || values.action_id.is_none()
                    || values.expected_revision.is_none())
            {
                return Err(CliFailure::invalid_args(
                    "space bootstrap apply 需要把 plan 返回的 --plan-digest、--action-id 与 --expected-revision 原样带回",
                ));
            }
            if !apply
                && (values.plan_digest.is_some()
                    || values.action_id.is_some()
                    || values.expected_revision.is_some())
            {
                return Err(CliFailure::invalid_args(
                    "space bootstrap plan 不接受 apply 专用的 --plan-digest、--action-id 或 --expected-revision",
                ));
            }
            Ok(Command::Bootstrap {
                workspace_id: values.workspace.take(),
                pack_id,
                apply,
                agent_id: values.agent.take(),
                model_id: values.model.take(),
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                expected_revision: values.expected_revision,
            })
        }
        _ => Err(CliFailure::invalid_args(
            "usage: genet space inspect|children|component set|component remove|parent set|lifecycle set|builder|bootstrap list|plan|apply|approval request ...",
        )),
    }
}

#[derive(Default)]
struct Values {
    workspace: Option<String>,
    component: Option<String>,
    role: Option<String>,
    parent: Option<String>,
    lifecycle: Option<String>,
    name: Option<String>,
    pack: Option<String>,
    agent: Option<String>,
    model: Option<String>,
    plan_digest: Option<String>,
    action_id: Option<String>,
    expected_revision: Option<u64>,
    challenge: Option<String>,
    plan: bool,
    revision: Option<u64>,
    disabled: bool,
    detach: bool,
    dry_run: bool,
    require_no_post_commands: bool,
}

impl Values {
    fn validate_change_mode(&self) -> Result<(), CliFailure> {
        if self.plan && (self.plan_digest.is_some() || self.action_id.is_some()) {
            return Err(CliFailure::invalid_args(
                "--plan 不接受 --plan-digest 或 --action-id",
            ));
        }
        if self.plan_digest.is_some() != self.action_id.is_some() {
            return Err(CliFailure::invalid_args(
                "AgentSpace apply 必须同时提供 --plan-digest 与 --action-id",
            ));
        }
        Ok(())
    }

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
                "--workspace" => values.workspace = Some(next(&mut index)?),
                "--component" => values.component = Some(next(&mut index)?),
                "--role" => values.role = Some(next(&mut index)?),
                "--parent" => values.parent = Some(next(&mut index)?),
                "--lifecycle" => values.lifecycle = Some(next(&mut index)?),
                "--name" => values.name = Some(next(&mut index)?),
                "--pack" => values.pack = Some(next(&mut index)?),
                "--agent" => values.agent = Some(next(&mut index)?),
                "--model" => values.model = Some(next(&mut index)?),
                "--plan-digest" => values.plan_digest = Some(next(&mut index)?),
                "--action-id" => values.action_id = Some(next(&mut index)?),
                "--expected-revision" => {
                    let value = next(&mut index)?;
                    values.expected_revision = Some(value.parse().map_err(|_| {
                        CliFailure::invalid_args("--expected-revision 需要非负整数")
                    })?);
                }
                "--challenge" => values.challenge = Some(next(&mut index)?),
                "--plan" => values.plan = true,
                "--revision" => {
                    let value = next(&mut index)?;
                    values.revision = Some(
                        value
                            .parse()
                            .map_err(|_| CliFailure::invalid_args("--revision 需要非负整数"))?,
                    );
                }
                "--disabled" => values.disabled = true,
                "--detach" => values.detach = true,
                "--dry-run" => values.dry_run = true,
                "--require-no-post-commands" => values.require_no_post_commands = true,
                other => {
                    return Err(CliFailure::invalid_args(format!("未知选项：{other}")));
                }
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
    fn mounting_a_worker_carries_its_role_and_stays_enabled_by_default() {
        let command = parse(&[
            "component".into(),
            "set".into(),
            "--component".into(),
            "worker".into(),
            "--role".into(),
            "coder".into(),
        ])
        .unwrap();

        let Command::Configure {
            revision,
            operation,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(revision, None);
        assert_eq!(
            operation,
            AgentSpaceOperation::SetComponent {
                component_id: "worker".into(),
                enabled: true,
                role: Some("coder".into()),
            }
        );
    }

    #[test]
    fn disabling_a_component_is_stated_rather_than_implied_by_removal() {
        let command = parse(&[
            "component".into(),
            "set".into(),
            "--component".into(),
            "reviewer".into(),
            "--disabled".into(),
            "--revision".into(),
            "4".into(),
        ])
        .unwrap();

        let Command::Configure {
            revision,
            operation,
            ..
        } = command
        else {
            panic!("wrong command")
        };
        assert_eq!(revision, Some(4));
        assert_eq!(
            operation,
            AgentSpaceOperation::SetComponent {
                component_id: "reviewer".into(),
                enabled: false,
                role: None,
            }
        );
    }

    #[test]
    fn detaching_and_attaching_are_the_same_verb_with_one_answer() {
        let Command::Configure { operation, .. } =
            parse(&["parent".into(), "set".into(), "--detach".into()]).unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(
            operation,
            AgentSpaceOperation::SetParent {
                parent_workspace_id: None,
            }
        );

        assert!(
            parse(&["parent".into(), "set".into()])
                .unwrap_err()
                .message
                .contains("--parent"),
            "silence must not be read as a request to detach"
        );
        assert!(parse(&[
            "parent".into(),
            "set".into(),
            "--detach".into(),
            "--parent".into(),
            "ws_a".into(),
        ])
        .unwrap_err()
        .message
        .contains("不能同时使用"));
    }

    #[test]
    fn a_component_verb_names_the_component_it_acts_on() {
        assert!(parse(&["component".into(), "set".into()])
            .unwrap_err()
            .message
            .contains("--component"));
        assert!(parse(&["component".into(), "remove".into()])
            .unwrap_err()
            .message
            .contains("--component"));
        assert!(parse(&["component".into()])
            .unwrap_err()
            .message
            .contains("usage:"));
    }

    #[test]
    fn lifecycle_is_never_guessed() {
        assert!(parse(&["lifecycle".into(), "set".into()])
            .unwrap_err()
            .message
            .contains("--lifecycle"));
        let Command::Configure { operation, .. } = parse(&[
            "lifecycle".into(),
            "set".into(),
            "--lifecycle".into(),
            "pooled".into(),
        ])
        .unwrap() else {
            panic!("wrong command")
        };
        assert_eq!(
            operation,
            AgentSpaceOperation::SetLifecycle {
                lifecycle: "pooled".into(),
            }
        );
    }

    #[test]
    fn builder_flags_are_scoped_to_the_build_operation() {
        let Command::Builder {
            space_name,
            operation,
            ..
        } = parse(&[
            "builder".into(),
            "build".into(),
            "--name".into(),
            "coder".into(),
            "--dry-run".into(),
            "--require-no-post-commands".into(),
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(space_name, "coder");
        assert_eq!(
            operation,
            AgentSpaceBuilderOperation::Build {
                dry_run: true,
                require_no_post_commands: true,
            }
        );
        assert!(parse(&[
            "builder".into(),
            "verify".into(),
            "--name".into(),
            "coder".into(),
            "--dry-run".into(),
        ])
        .is_err());
    }

    #[test]
    fn bootstrap_plan_and_apply_share_one_explicit_pack_contract() {
        let Command::Bootstrap {
            pack_id,
            apply,
            agent_id,
            model_id,
            ..
        } = parse(&[
            "bootstrap".into(),
            "plan".into(),
            "--pack".into(),
            "game-delivery-v1".into(),
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert_eq!(pack_id, "game-delivery-v1");
        assert!(!apply);
        assert_eq!(agent_id, None);
        assert_eq!(model_id, None);

        let Command::Bootstrap {
            apply,
            agent_id,
            model_id,
            plan_digest,
            action_id,
            expected_revision,
            ..
        } = parse(&[
            "bootstrap".into(),
            "apply".into(),
            "--pack".into(),
            "game-delivery-v1".into(),
            "--agent".into(),
            "codex".into(),
            "--model".into(),
            "gpt-5".into(),
            "--plan-digest".into(),
            "sha256:plan".into(),
            "--action-id".into(),
            "bootstrap-1".into(),
            "--expected-revision".into(),
            "4".into(),
        ])
        .unwrap()
        else {
            panic!("wrong command")
        };
        assert!(apply);
        assert_eq!(agent_id.as_deref(), Some("codex"));
        assert_eq!(model_id.as_deref(), Some("gpt-5"));
        assert_eq!(plan_digest.as_deref(), Some("sha256:plan"));
        assert_eq!(action_id.as_deref(), Some("bootstrap-1"));
        assert_eq!(expected_revision, Some(4));

        assert!(parse(&["bootstrap".into(), "apply".into()])
            .unwrap_err()
            .message
            .contains("--pack"));
        assert!(parse(&[
            "bootstrap".into(),
            "apply".into(),
            "--pack".into(),
            "game-delivery-v1".into(),
        ])
        .unwrap_err()
        .message
        .contains("--plan-digest"));
    }

    #[test]
    fn approval_request_is_a_distinct_non_approving_command() {
        let Command::RequestApproval { challenge_id } = parse(&[
            "approval".into(),
            "request".into(),
            "--challenge".into(),
            "pm-bootstrap-123".into(),
        ])
        .unwrap() else {
            panic!("wrong command")
        };
        assert_eq!(challenge_id, "pm-bootstrap-123");
        assert!(parse(&["approval".into(), "request".into()]).is_err());
        assert!(parse(&[
            "approval".into(),
            "approve".into(),
            "--challenge".into(),
            "pm-bootstrap-123".into(),
        ])
        .is_err());
    }

    #[test]
    fn bootstrap_pack_discovery_is_an_explicit_read() {
        assert!(matches!(
            parse(&["bootstrap".into(), "list".into()]).unwrap(),
            Command::BootstrapList
        ));
        assert!(parse(&[
            "bootstrap".into(),
            "list".into(),
            "--pack".into(),
            "game-delivery-v1".into(),
        ])
        .is_err());
    }

    #[test]
    fn bootstrap_failures_expose_a_stable_machine_readable_recovery_contract() {
        let failure = bootstrap_rpc_error(
            RpcError::Remote(genehub_proto::ProtocolError {
                code: genehub_proto::ErrorCode::BadRequest,
                message: "dirtyGit: commit or clean README.md".into(),
            }),
            Some("sha256:plan"),
        );
        assert_eq!(failure.code, "dirtyGit");
        assert!(!failure.retryable);
        let details = failure.details.unwrap();
        assert_eq!(details["stage"], "gitPreflight");
        assert_eq!(details["changed"], false);
        assert_eq!(details["rolledBack"], true);
        assert_eq!(details["planDigest"], "sha256:plan");
        assert!(details["recoveryAction"]
            .as_str()
            .unwrap()
            .contains("Commit or clean"));
    }

    #[test]
    fn rollback_incomplete_is_never_reported_as_safely_retriable() {
        let failure = bootstrap_rpc_error(
            RpcError::Remote(genehub_proto::ProtocolError {
                code: genehub_proto::ErrorCode::BadRequest,
                message: "rollbackIncomplete: registry remained changed".into(),
            }),
            Some("sha256:plan"),
        );
        assert_eq!(failure.code, "rollbackIncomplete");
        assert_eq!(failure.details.as_ref().unwrap()["rolledBack"], false);
        assert!(!failure.retryable);
    }
}
