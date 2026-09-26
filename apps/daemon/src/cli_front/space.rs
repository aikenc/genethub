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
use super::rpc::Rpc;
use super::target::Selection;
use super::workflow::resolve_workspace;
use super::{query, EXIT_OK};

#[derive(Debug)]
enum Command {
    Open {
        root: String,
    },
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
        target_workspace_id: Option<String>,
        space_name: String,
        operation: AgentSpaceBuilderOperation,
        plan: bool,
        plan_digest: Option<String>,
        action_id: Option<String>,
        expected_revision: Option<u64>,
    },
    RequestApproval {
        challenge_id: String,
    },
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
        Command::Open { root } => {
            let Reply::Workspace(workspace) = rpc
                .call(Request::WorkspaceOpen { root })
                .await
                .map_err(query::rpc_error)?
            else {
                return Err(CliFailure::protocol(
                    "workspace.open returned the wrong reply",
                ));
            };
            output::succeed("space.open", json!({"workspace": workspace}));
            Ok(EXIT_OK)
        }
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
            target_workspace_id,
            space_name,
            operation,
            plan,
            plan_digest,
            action_id,
            expected_revision,
        } => {
            let workspace_id = resolve_workspace(rpc, workspace_id).await?;
            let Reply::AgentSpaceBuilder(report) = rpc
                .call(Request::AgentSpaceBuilder {
                    workspace_id,
                    target_workspace_id,
                    space_name,
                    operation,
                    plan: plan.then_some(true),
                    plan_digest,
                    action_id,
                    expected_revision,
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
                    "status": "waitingForHuman",
                    "approved": false,
                }),
            );
            Ok(EXIT_OK)
        }
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
        ("open", root) if args.len() == 2 => {
            let root = crate::guest_paths::inbound_absolute(root)
                .ok_or_else(|| CliFailure::invalid_args("space open requires an absolute directory or code-workspace path"))?;
            Ok(Command::Open { root: root.to_string_lossy().into_owned() })
        }
        ("open", _) => Err(CliFailure::invalid_args("usage: genet space open <absolute-directory-or-code-workspace>")),
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
            values.validate_change_mode()?;
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
            if (values.plan || values.plan_digest.is_some() || values.action_id.is_some())
                && (action != "build" || values.dry_run)
            {
                return Err(CliFailure::invalid_args(
                    "Builder management plans require space builder build (without --dry-run)",
                ));
            }
            Ok(Command::Builder {
                workspace_id: values.workspace.take(),
                target_workspace_id: values.target_workspace.take(),
                space_name,
                operation,
                plan: values.plan,
                plan_digest: values.plan_digest.take(),
                action_id: values.action_id.take(),
                expected_revision: values.expected_revision.or(values.revision),
            })
        }
        ("approval", "request") => {
            let mut values = Values::parse(rest(2))?;
            let challenge_id = values.challenge.take().ok_or_else(|| {
                CliFailure::invalid_args("space approval request 需要 --challenge <id>")
            })?;
            Ok(Command::RequestApproval { challenge_id })
        }
        _ => Err(CliFailure::invalid_args(
            "usage: genet space inspect|children|component set|component remove|parent set|lifecycle set|builder|approval request ...",
        )),
    }
}

#[derive(Default)]
struct Values {
    workspace: Option<String>,
    target_workspace: Option<String>,
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
                "--target-workspace" => values.target_workspace = Some(next(&mut index)?),
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
}
