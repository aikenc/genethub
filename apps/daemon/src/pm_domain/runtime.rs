//! Cheap daemon supervision for PM projects.
//!
//! This task never asks an LLM to poll. It samples durable project/WorkSession
//! facts, records bounded backoff, and starts a PM turn on a material change or
//! when actionable graph state has no worker that can produce the next event.
//! A busy PM keeps the durable pending wake for a later tick.

use std::fmt::Write as _;
use std::time::Duration;

use genehub_proto::SessionStatus;
use sha2::{Digest, Sha256};

use super::project::{ProjectLifecycle, ProjectState};
use super::supervisor::WakeDispatchOutcome;
use super::task_graph::{ReviewVerdict, WorkPackage, WorkPackageStatus};
use crate::session::RoundOutcome;
use crate::state::Shared;

const SAMPLE_INTERVAL: Duration = Duration::from_secs(2);
const WAKE_PROMPT: &str = "PM supervisor event: one or more managed WorkSessions changed status. Reconstruct the durable project with `genet pm project show`, inspect the exact bound WorkSessions and Git evidence, then update only affected work packages. Do not infer completion from this wakeup, and answer any pending user guidance before autonomous follow-up.";

pub fn spawn(state: Shared) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(SAMPLE_INTERVAL);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = state.shutdown.notified() => return,
                _ = interval.tick() => {
                    if let Err(error) = tick(&state).await {
                        tracing::warn!(%error, "PM supervisor tick failed");
                        state.diagnostics.record("pm", "supervisor", "error", Some("tick"));
                    }
                }
            }
        }
    })
}

async fn tick(state: &Shared) -> anyhow::Result<()> {
    let projects = state.projects.list_all().await?;
    for project in projects {
        if project.lifecycle != ProjectLifecycle::Active {
            continue;
        }
        if let Err(error) = supervise_project(state, project.clone()).await {
            tracing::warn!(
                %error,
                project_workspace_id = %project.project_workspace_id,
                "PM supervisor project tick failed"
            );
            state
                .diagnostics
                .record("pm", "supervisor", "project-error", Some("tick"));
        }
    }
    Ok(())
}

async fn supervise_project(state: &Shared, project: ProjectState) -> anyhow::Result<()> {
    let mut observations = Vec::new();
    for package in project.work_packages.values() {
        let session_id = match package.status {
            WorkPackageStatus::Running => package.work_session_id.as_deref(),
            WorkPackageStatus::Review
                if package
                    .review
                    .as_ref()
                    .is_some_and(|review| review.verdict != Some(ReviewVerdict::Pass)) =>
            {
                package
                    .review
                    .as_ref()
                    .map(|review| review.session_id.as_str())
            }
            _ => None,
        };
        let session_status = match session_id {
            Some(session_id) => Some(
                state
                    .sessions
                    .summary(session_id)
                    .await
                    .map(|summary| summary.status)
                    .unwrap_or(SessionStatus::Failed),
            ),
            None => None,
        };
        observations.push((
            package.id.as_str(),
            package.status,
            session_id,
            session_status,
        ));
    }
    observations.sort_by(|left, right| left.0.cmp(right.0));
    let digest = observation_digest(&observations);
    let active_work = !observations.is_empty();
    let wake_when_quiet = observations
        .iter()
        .any(|(_, _, _, status)| status.is_some_and(|status| status != SessionStatus::Running))
        || project
            .work_packages
            .values()
            .any(|package| package_requires_manager(package, &project))
        || (!project.work_packages.is_empty()
            && project.work_packages.values().all(|package| {
                matches!(
                    package.status,
                    WorkPackageStatus::Accepted | WorkPackageStatus::Cancelled
                )
            }));
    let decision = state
        .projects
        .reconcile_supervisor(
            &project.project_workspace_id,
            &project.controller_session_id,
            digest.clone(),
            active_work,
            wake_when_quiet,
            chrono::Utc::now().timestamp_millis(),
        )
        .await?;
    if !decision.wake_manager {
        return Ok(());
    }

    let manager = match state.sessions.summary(&project.controller_session_id).await {
        Ok(summary) => summary,
        Err(error) => {
            tracing::warn!(%error, "PM supervisor cannot resolve controller session");
            return Ok(());
        }
    };
    if matches!(
        manager.status,
        SessionStatus::Running | SessionStatus::Waiting
    ) {
        return Ok(());
    }
    if let Some(turn_id) = decision.project.supervisor.wake_turn_id.as_deref() {
        let outcome = match state
            .sessions
            .turn_outcome(&project.controller_session_id, turn_id)
            .await
        {
            Ok(Some(RoundOutcome::Completed)) => WakeDispatchOutcome::Completed,
            Ok(Some(RoundOutcome::Failed)) => WakeDispatchOutcome::Failed,
            Ok(Some(RoundOutcome::Canceled | RoundOutcome::Superseded)) | Ok(None) | Err(_) => {
                WakeDispatchOutcome::Interrupted
            }
        };
        let now_ms = chrono::Utc::now().timestamp_millis();
        state
            .projects
            .settle_supervisor_wake_dispatch(
                &project.project_workspace_id,
                &project.controller_session_id,
                &digest,
                turn_id,
                outcome,
                now_ms,
            )
            .await?;
        match outcome {
            WakeDispatchOutcome::Completed => {
                state
                    .diagnostics
                    .record("pm", "supervisor", "acknowledged", None);
                return Ok(());
            }
            WakeDispatchOutcome::Failed => {
                state
                    .diagnostics
                    .record("pm", "supervisor", "deferred", Some("failed-turn"));
                return Ok(());
            }
            WakeDispatchOutcome::Interrupted => {
                state.diagnostics.record("pm", "supervisor", "retry", None);
            }
        }
    }
    let providers = state.providers().await;
    match state
        .sessions
        .send(
            &project.controller_session_id,
            WAKE_PROMPT.to_string(),
            Vec::new(),
            &providers,
            None,
            None,
        )
        .await
    {
        Ok(turn_id) => {
            state
                .projects
                .mark_supervisor_wake_dispatched(
                    &project.project_workspace_id,
                    &project.controller_session_id,
                    &digest,
                    &turn_id,
                )
                .await?;
            state.diagnostics.record("pm", "supervisor", "woken", None);
        }
        Err(error) => {
            // A race with a user turn is normal. The persisted pending bit
            // retries after that turn settles.
            tracing::debug!(%error, "PM supervisor wake deferred");
        }
    }
    Ok(())
}

fn package_requires_manager(package: &WorkPackage, project: &ProjectState) -> bool {
    match package.status {
        WorkPackageStatus::Planned => package.dependencies.iter().all(|dependency| {
            project
                .work_packages
                .get(dependency)
                .is_some_and(|package| package.status == WorkPackageStatus::Accepted)
        }),
        WorkPackageStatus::Ready
        | WorkPackageStatus::Waiting
        | WorkPackageStatus::Candidate
        | WorkPackageStatus::Blocked => true,
        WorkPackageStatus::Running
        | WorkPackageStatus::Review
        | WorkPackageStatus::Accepted
        | WorkPackageStatus::Cancelled => false,
    }
}

fn observation_digest(
    observations: &[(&str, WorkPackageStatus, Option<&str>, Option<SessionStatus>)],
) -> String {
    let mut hash = Sha256::new();
    for (package, package_status, session, session_status) in observations {
        hash.update(package.as_bytes());
        hash.update([0]);
        hash.update(format!("{package_status:?}").as_bytes());
        hash.update([0]);
        hash.update(session.unwrap_or("-").as_bytes());
        hash.update([0]);
        hash.update(
            session_status
                .map(|status| format!("{status:?}"))
                .unwrap_or_else(|| "-".into())
                .as_bytes(),
        );
        hash.update([0]);
    }
    let mut output = String::with_capacity(71);
    output.push_str("sha256:");
    for byte in hash.finalize() {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn observation_is_ordered_and_status_sensitive() {
        let left = observation_digest(&[
            (
                "a",
                WorkPackageStatus::Running,
                Some("s_a"),
                Some(SessionStatus::Running),
            ),
            (
                "b",
                WorkPackageStatus::Review,
                Some("s_b"),
                Some(SessionStatus::Idle),
            ),
        ]);
        assert_eq!(
            left,
            observation_digest(&[
                (
                    "a",
                    WorkPackageStatus::Running,
                    Some("s_a"),
                    Some(SessionStatus::Running),
                ),
                (
                    "b",
                    WorkPackageStatus::Review,
                    Some("s_b"),
                    Some(SessionStatus::Idle),
                ),
            ])
        );
        assert_ne!(
            left,
            observation_digest(&[
                (
                    "a",
                    WorkPackageStatus::Running,
                    Some("s_a"),
                    Some(SessionStatus::Idle),
                ),
                (
                    "b",
                    WorkPackageStatus::Review,
                    Some("s_b"),
                    Some(SessionStatus::Idle),
                ),
            ])
        );
        assert_ne!(
            left,
            observation_digest(&[
                ("a", WorkPackageStatus::Candidate, None, None,),
                (
                    "b",
                    WorkPackageStatus::Review,
                    Some("s_b"),
                    Some(SessionStatus::Idle),
                ),
            ])
        );
    }
}
