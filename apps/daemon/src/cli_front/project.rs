//! PM-owned project mutations exposed through the same public CLI as sessions.

use genehub_proto::{Reply, Request};
use serde_json::json;

use super::output::{self, CliFailure};
use super::target::Selection;

pub async fn register_agent_space(args: &[String], selection: &Selection) -> i32 {
    let source = match args {
        [verb, source] if verb == "register-agent-space" && !source.trim().is_empty() => source,
        _ => {
            return output::fail(CliFailure::invalid_args(
                "usage: genet workspace register-agent-space <space.code-workspace>",
            ))
        }
    };
    let context = match super::pm_project::Context::load().await {
        Ok(context) => context,
        Err(error) => return output::fail(error),
    };
    let requested = std::path::PathBuf::from(source);
    let source = if requested.is_absolute() {
        requested
    } else {
        context.root.join(requested)
    };
    let rpc = match super::query::connect_selected(selection).await {
        Ok(rpc) => rpc,
        Err(error) => return output::fail(error),
    };
    match rpc
        .call(Request::WorkspaceRegisterAgentSpace {
            source: source.to_string_lossy().into_owned(),
        })
        .await
        .map_err(super::query::rpc_error)
    {
        Ok(Reply::Workspace(workspace)) => output::succeed(
            "workspace.registerAgentSpace",
            json!({"workspace": workspace}),
        ),
        Ok(other) => output::fail(super::query::unexpected_reply("workspace", &other)),
        Err(error) => output::fail(error),
    }
}
