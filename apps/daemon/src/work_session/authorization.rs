//! Mutation policy for WorkAgent sessions.
//!
//! Reading and Fork keep the existing public session protocol. Every mutation
//! is accepted only from the daemon-authenticated PM session recorded in the
//! durable WorkSession metadata.

use anyhow::Result;
use genehub_proto::{Request, SessionKind};

use crate::authz::Principal;
use crate::session::SessionManager;

pub async fn authorize(
    sessions: &SessionManager,
    caller: &Principal,
    request: &Request,
) -> Result<()> {
    let Some(session_id) = mutation_target(request) else {
        return Ok(());
    };
    let summary = sessions.summary(session_id).await?;
    if summary.kind == Some(SessionKind::Pm)
        && matches!(
            request,
            Request::SessionArchive { .. } | Request::SessionDelete { .. }
        )
    {
        anyhow::bail!("the PM Agent session is retained while its project and Agent Spaces exist");
    }
    if summary.kind != Some(SessionKind::Work) {
        return Ok(());
    }
    let controller = summary
        .work
        .as_ref()
        .map(|work| work.controller_session_id.as_str())
        .ok_or_else(|| anyhow::anyhow!("WorkAgent session has no durable controller"))?;
    if caller.project_manager_session_id() == Some(controller) {
        return Ok(());
    }
    anyhow::bail!(
        "this WorkAgent session is read-only; guide its project manager or Fork a completed turn"
    )
}

fn mutation_target(request: &Request) -> Option<&str> {
    match request {
        Request::SessionSend { session_id, .. }
        | Request::SessionArtifactBegin { session_id, .. }
        | Request::SessionArtifactChunk { session_id, .. }
        | Request::SessionArtifactFinish { session_id, .. }
        | Request::SessionArtifactAbort { session_id, .. }
        | Request::SessionInterrupt { session_id }
        | Request::SessionClose { session_id }
        | Request::SessionArchive { session_id, .. }
        | Request::SessionRename { session_id, .. }
        | Request::SessionDelete { session_id }
        | Request::SessionSetModel { session_id, .. }
        | Request::SessionSetMode { session_id, .. }
        | Request::SessionSetEffort { session_id, .. }
        | Request::SessionSetRuntimeAxis { session_id, .. }
        | Request::SessionRespondPermission { session_id, .. }
        | Request::ProcessKill { session_id, .. }
        | Request::ProcessKillAll { session_id } => Some(session_id),
        _ => None,
    }
}
