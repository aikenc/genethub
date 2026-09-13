//! PM build plans reuse project-control authority, receipts and source fences.

use std::path::Path;

use anyhow::{bail, Context, Result};
use genehub_proto::{AgentSpaceBuilderOperation, AgentSpaceBuilderPlan, AgentSpaceBuilderReport};
use serde_json::json;

use crate::state::Shared;

const ACTION: &str = "agentSpace.builder";
const PACK: &str = "agent-space-builder";

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
    recovery_authorized: bool,
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
    let _mutation = state.project_control.mutation_lock().await;
    let project = state.workspaces.get(project_id).await?;
    let project_root = project.root.canonicalize()?;
    let root = space_root.canonicalize()?;

    if !planning {
        if let (Some(session), Some(digest), Some(action)) = (controller, plan_digest, action_id) {
            if let Some(report) = state
                .project_control
                .completed_action::<AgentSpaceBuilderReport>(
                    project_id, session, ACTION, digest, action,
                )?
            {
                if !report.management_plan.as_ref().is_some_and(|plan| {
                    plan.operation == *operation && plan.target_root == root.display().to_string()
                }) {
                    bail!("actionConflict: this Builder receipt identifies another operation or target");
                }
                return Ok(report);
            }
        }
    }

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
    let canonical_root = project_root.display().to_string();
    if planning {
        if let Some(session) = controller {
            if !state.project_control.is_bound(project_id, session) && !recovery_authorized {
                bail!("projectControlRequired: this PM does not hold the project's management binding");
            }
            let approval = state.project_control.issue_management(crate::project_control::ChallengeSpec {
                controller_session_id: session.into(), workspace_id: project_id.into(),
                canonical_root, action: ACTION.into(), pack_id: PACK.into(),
                pack_digest: input_digest.clone(), plan_digest: digest,
                expected_revision: revision, git_head: None, status_digest: input_digest,
                title: "应用 AgentSpace Builder 计划".into(),
                detail: format!("Build {} at project revision {revision}; only the previewed projections are written", root.display()),
            }, project_id, recovery_authorized).await?;
            if approval.is_some() {
                bail!("projectControlRequired: project management binding changed; inspect the current authority");
            }
        }
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
        let registered = target
            .agent_space
            .as_ref()
            .is_some_and(|config| !config.components.is_empty());
        let runs =
            crate::workflow::project_active_run_ids(&state.paths.root, project_id, &project_root)?;
        if active || (registered && !runs.is_empty()) {
            bail!("activeResourceConflict: finish or cancel affected executions before rebuilding this Space");
        }
    }

    let reservation = if let Some(session) = controller {
        let action = action_id.context("Builder apply requires --action-id")?;
        Some((
            state
                .project_control
                .reserve(
                    session,
                    project_id,
                    &canonical_root,
                    ACTION,
                    PACK,
                    &input_digest,
                    &digest,
                    revision,
                    None,
                    &input_digest,
                    action,
                    recovery_authorized,
                )
                .await?,
            action,
        ))
    } else {
        None
    };
    let result = super::run_bound(
        &project_root,
        &root,
        super::Command::Build { dry_run: false },
        *require_no_post_commands,
        Some(&input_digest),
    );
    let mut report: AgentSpaceBuilderReport = match result {
        Ok(report) => report.into(),
        Err(error) => {
            if let Some((challenge, action)) = &reservation {
                state
                    .project_control
                    .release_failed(challenge, action)
                    .await?;
            }
            return Err(error.into());
        }
    };
    report.management_plan = Some(plan);
    if let (Some(session), Some((challenge, action))) = (controller, reservation) {
        // A receipt failure leaves the applying fence set. Never blindly repeat
        // an operation whose filesystem result may already exist.
        state
            .project_control
            .record_completed_action(project_id, session, ACTION, &digest, action, &report)
            .context("mutationReceiptFailed: inspect Builder outputs before recovery")?;
        state.project_control.complete(&challenge, action).await?;
    }
    Ok(report)
}
