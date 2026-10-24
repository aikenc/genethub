use super::{output::CliFailure, query, rpc::Rpc};
use serde_json::json;
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
                        "projectBindingUnavailable",
                        format!("无法读取项目归属会话：{error:#}"),
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
                        "projectBindingUnavailable",
                        format!("无法解析所属项目：{error:#}"),
                        None,
                    )
                });
        }
    }
    Err(CliFailure::business(
        "projectBindingUnavailable",
        "项目归属链无效或超过上限",
        None,
    ))
}

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
    // a child as the project. Walk the caller's ownership tree instead.
    if let crate::authz::Principal::SessionController { session_id } = super::caller_principal() {
        let state = super::local_state()
            .map_err(|message| CliFailure::business("projectBindingUnavailable", message, None))?;
        let summary = state.sessions.summary(&session_id).await.map_err(|error| {
            CliFailure::business(
                "projectBindingUnavailable",
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
