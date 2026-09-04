//! AgentSpace composition commands exposed through the same production
//! `genet` CLI every Agent session receives.
//!
//! These are the typed verbs a PM's Skill calls. Deliberately mechanical:
//! the daemon owns the invariants, and the methodology for *when* to mount a
//! component or grow a subteam belongs in the project's own Skill assets, not
//! in this parser.

use genehub_proto::{AgentSpaceOperation, Reply, Request};
use serde_json::json;

use super::output::{self, CliFailure};
use super::rpc::Rpc;
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
            let Reply::Workspace(space) = rpc
                .call(Request::AgentSpaceConfigure {
                    workspace_id,
                    expected_revision,
                    operation,
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
            let component_id = values.component.take().ok_or_else(|| {
                CliFailure::invalid_args("space component set 需要 --component <pm|executor|worker|reviewer>")
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                operation: AgentSpaceOperation::SetComponent {
                    component_id,
                    enabled: !values.disabled,
                    role: values.role.take(),
                },
            })
        }
        ("component", "remove") => {
            let mut values = Values::parse(rest(2))?;
            let component_id = values.component.take().ok_or_else(|| {
                CliFailure::invalid_args("space component remove 需要 --component <id>")
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                operation: AgentSpaceOperation::RemoveComponent { component_id },
            })
        }
        ("parent", "set") => {
            let mut values = Values::parse(rest(2))?;
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
                operation: AgentSpaceOperation::SetParent {
                    parent_workspace_id: values.parent.take(),
                },
            })
        }
        ("lifecycle", "set") => {
            let mut values = Values::parse(rest(2))?;
            let lifecycle = values.lifecycle.take().ok_or_else(|| {
                CliFailure::invalid_args(
                    "space lifecycle set 需要 --lifecycle <persistent|pooled|ephemeral>",
                )
            })?;
            Ok(Command::Configure {
                workspace_id: values.workspace.take(),
                revision: values.revision,
                operation: AgentSpaceOperation::SetLifecycle { lifecycle },
            })
        }
        _ => Err(CliFailure::invalid_args(
            "usage: genet space inspect|children|component set|component remove|parent set|lifecycle set ...",
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
    revision: Option<u64>,
    disabled: bool,
    detach: bool,
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
                "--workspace" => values.workspace = Some(next(&mut index)?),
                "--component" => values.component = Some(next(&mut index)?),
                "--role" => values.role = Some(next(&mut index)?),
                "--parent" => values.parent = Some(next(&mut index)?),
                "--lifecycle" => values.lifecycle = Some(next(&mut index)?),
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
}
