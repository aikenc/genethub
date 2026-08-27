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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fork_and_reads_are_not_mutations_but_every_control_surface_is() {
        assert_eq!(
            mutation_target(&Request::SessionFork {
                session_id: "s".into(),
                turn_id: "t".into(),
                target: None,
            }),
            None
        );
        assert_eq!(
            mutation_target(&Request::SessionSend {
                session_id: "s".into(),
                text: "continue".into(),
                attachments: vec![],
                artifact_preview_base_url: None,
                continues_round: None,
            }),
            Some("s")
        );
        assert_eq!(
            mutation_target(&Request::ProcessKillAll {
                session_id: "s".into(),
            }),
            Some("s")
        );
    }

    #[tokio::test]
    async fn only_the_recorded_pm_identity_may_mutate_a_work_session() {
        let dir = tempfile::tempdir().unwrap();
        let homes = crate::session::WorkspaceHomes::default();
        homes.attach("w", dir.path());
        let sessions = crate::session::SessionManager::new(
            crate::session::Store::new(homes),
            Arc::new(crate::adapter::registry::Registry::new(
                &std::collections::BTreeMap::new(),
            )),
            16,
        );
        let work = sessions
            .create_work_session(
                "w",
                dir.path().to_path_buf(),
                "wp-1",
                "s_pm",
                "genet",
                None,
                None,
                Default::default(),
                None,
            )
            .await
            .unwrap();
        let send = Request::SessionSend {
            session_id: work.id,
            text: "continue".into(),
            attachments: vec![],
            artifact_preview_base_url: None,
            continues_round: None,
        };

        assert!(authorize(&sessions, &Principal::LocalUser, &send)
            .await
            .unwrap_err()
            .to_string()
            .contains("read-only"));
        assert!(authorize(
            &sessions,
            &Principal::ProjectManager {
                session_id: "s_other".into(),
            },
            &send,
        )
        .await
        .is_err());
        authorize(
            &sessions,
            &Principal::ProjectManager {
                session_id: "s_pm".into(),
            },
            &send,
        )
        .await
        .unwrap();
    }
}
