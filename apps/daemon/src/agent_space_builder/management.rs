//! AgentSpace Builder build plans.

use std::path::Path;

use anyhow::{bail, Context, Result};
use genehub_proto::{AgentSpaceBuilderOperation, AgentSpaceBuilderPlan, AgentSpaceBuilderReport};
use serde_json::json;

use crate::state::Shared;

#[allow(clippy::too_many_arguments)]
pub(crate) async fn build(
    state: &Shared,
    project_id: &str,
    space_root: &Path,
    operation: &AgentSpaceBuilderOperation,
    controller: Option<&str>,
    planning: bool,
    plan_digest: Option<&str>,
    action_id: Option<&str>,
    expected_revision: Option<u64>,
    _recovery_authorized: bool,
) -> Result<AgentSpaceBuilderReport> {
    let AgentSpaceBuilderOperation::Build {
        dry_run: false,
        require_no_post_commands,
    } = operation
    else {
        bail!(
            "Builder management plans support build; use check, explain or verify for inspection"
        );
    };
    if planning && (plan_digest.is_some() || action_id.is_some()) {
        bail!("Builder planning cannot apply a previous plan");
    }
    let project = state.workspaces.get(project_id).await?;
    let project_root = project.root.canonicalize()?;
    let root = space_root.canonicalize()?;
    let project_space = state.workspaces.agent_space(project_id).await?;
    let revision = project_space.revision;
    if expected_revision.is_some_and(|expected| expected != revision) {
        bail!("revisionConflict: project is at revision {revision}; obtain a new Builder plan");
    }
    // Names and paths identify the same registered target. No registration is
    // created just to preview a build for a new Space.
    let target = state.workspaces.list().await.into_iter().find(|space| {
        Path::new(&space.root)
            .canonicalize()
            .is_ok_and(|path| path == root)
    });
    let target_identity = target.as_ref().map(|space| {
        (
            &space.id,
            space.agent_space.as_ref().map(|config| config.revision),
            space
                .agent_space
                .as_ref()
                .map(|config| &config.builder_lock_digest),
        )
    });
    let preview = super::run(
        &project_root,
        &root,
        super::Command::Build { dry_run: true },
        *require_no_post_commands,
    )?;
    let input_digest = super::sha256_bytes(&serde_json::to_vec(
        preview
            .details
            .as_ref()
            .context("Builder preview omitted its planned model")?,
    )?);
    let digest = super::sha256_bytes(&serde_json::to_vec(&json!({
        "schema": "genehub.builder-management-plan.v1",
        "project": project_id,
        "projectRoot": project_root,
        "projectRevision": revision,
        "targetRoot": root,
        "targetIdentity": target_identity,
        "operation": operation,
        "inputDigest": input_digest,
    }))?);
    let plan = AgentSpaceBuilderPlan {
        plan_digest: digest.clone(),
        expected_revision: revision,
        target_root: root.display().to_string(),
        operation: operation.clone(),
    };
    if planning {
        let mut report: AgentSpaceBuilderReport = preview.into();
        report.management_plan = Some(plan);
        return Ok(report);
    }
    if plan_digest != Some(digest.as_str()) || expected_revision != Some(revision) {
        bail!("planStale: obtain space builder build --plan and apply its --plan-digest and --expected-revision");
    }

    // Rebuilding registered sources can change instructions of their Sessions.
    // New empty carriers do not conflict with the existing team's Runs.
    if let Some(target) = &target {
        let active = state
            .sessions
            .list(Some(&target.id), true)
            .await?
            .into_iter()
            .filter(|session| Some(session.id.as_str()) != controller)
            .any(|session| {
                matches!(
                    session.status,
                    genehub_proto::SessionStatus::Running | genehub_proto::SessionStatus::Waiting
                )
            });
        if active {
            bail!("activeResourceConflict: finish or cancel affected executions before rebuilding this Space");
        }
    }

    let result = super::run_bound(
        &project_root,
        &root,
        super::Command::Build { dry_run: false },
        *require_no_post_commands,
        Some(&input_digest),
    );
    let mut report: AgentSpaceBuilderReport = result?.into();
    report.management_plan = Some(plan);
    Ok(report)
}
