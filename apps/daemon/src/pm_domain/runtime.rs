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
const WAKE_PROMPT: &str = "PM supervisor batch: managed WorkSession facts changed. Read durable state once with `genet pm project show`, process every actionable item in this batch, and finish the turn. Inspect only terminal/failed WorkSessions or evidence needed for a pending transition; do not poll running work or replay already-bound gates. A user message still takes priority.";

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
        let controllers = if project.session_dcg_runs.is_empty() {
            vec![project.controller_session_id.clone()]
        } else {
            project.session_dcg_runs.keys().cloned().collect::<Vec<_>>()
        };
        for controller_session_id in controllers {
            if let Err(error) = supervise_run(state, project.clone(), &controller_session_id).await
            {
                tracing::warn!(
                    %error,
                    project_workspace_id = %project.project_workspace_id,
                    %controller_session_id,
                    "PM supervisor Workflow Run tick failed"
                );
                state
                    .diagnostics
                    .record("pm", "supervisor", "run-error", Some("tick"));
            }
        }
    }
    Ok(())
}

async fn supervise_run(
    state: &Shared,
    project: ProjectState,
    controller_session_id: &str,
) -> anyhow::Result<()> {
    let mut observations = Vec::new();
    for package in project
        .work_packages
        .values()
        .filter(|package| package.controller_session_id == controller_session_id)
    {
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
    let run = project.session_dcg_runs.get(controller_session_id);
    // Once a Workflow Run is terminal, its WorkPackages remain durable
    // evidence but must not keep waking that PM Session. Legacy projects with
    // no Run still derive liveness from their package observations.
    let active_work = run_has_active_work(run.map(|run| run.status), !observations.is_empty());
    let wake_when_quiet = observations
        .iter()
        .any(|(_, _, _, status)| status.is_some_and(|status| status != SessionStatus::Running))
        || project
            .work_packages
            .values()
            .filter(|package| package.controller_session_id == controller_session_id)
            .any(|package| package_requires_manager(package, &project))
        || (!observations.is_empty()
            && project
                .work_packages
                .values()
                .filter(|package| package.controller_session_id == controller_session_id)
                .all(|package| {
                    matches!(
                        package.status,
                        WorkPackageStatus::Accepted | WorkPackageStatus::Cancelled
                    )
                }))
        || run.is_some_and(|run| {
            run.status == super::dcg::DcgRunStatus::Active && observations.is_empty()
        });
    let decision = state
        .projects
        .reconcile_supervisor(
            &project.project_workspace_id,
            controller_session_id,
            digest.clone(),
            active_work,
            wake_when_quiet,
            chrono::Utc::now().timestamp_millis(),
        )
        .await?;
    if !decision.wake_manager {
        return Ok(());
    }

    let manager = match state.sessions.summary(controller_session_id).await {
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
    let run_supervisor = decision
        .project
        .session_supervisors
        .get(controller_session_id)
        .ok_or_else(|| anyhow::anyhow!("Workflow Run supervisor is unavailable"))?;
    if let Some(turn_id) = run_supervisor.wake_turn_id.as_deref() {
        let outcome = match state
            .sessions
            .turn_outcome(controller_session_id, turn_id)
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
                controller_session_id,
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
            controller_session_id,
            wake_prompt(&observations),
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
                    controller_session_id,
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

fn wake_prompt(
    observations: &[(&str, WorkPackageStatus, Option<&str>, Option<SessionStatus>)],
) -> String {
    let mut prompt = String::from(WAKE_PROMPT);
    prompt.push_str("\nCurrent package/session facts:");
    for (package, package_status, session_id, session_status) in observations.iter().take(32) {
        let _ = write!(
            prompt,
            "\n- {package}: package={package_status:?}, session={}, sessionStatus={}",
            session_id.unwrap_or("none"),
            session_status
                .map(|status| format!("{status:?}"))
                .unwrap_or_else(|| "none".into())
        );
    }
    if observations.len() > 32 {
        let _ = write!(
            prompt,
            "\n- … {} more packages; use the durable projection",
            observations.len() - 32
        );
    }
    prompt
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

fn run_has_active_work(
    status: Option<super::dcg::DcgRunStatus>,
    has_package_observations: bool,
) -> bool {
    match status {
        Some(super::dcg::DcgRunStatus::Discussion | super::dcg::DcgRunStatus::Active) => true,
        Some(super::dcg::DcgRunStatus::Completed | super::dcg::DcgRunStatus::Cancelled) => false,
        None => has_package_observations,
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

    #[test]
    fn wake_prompt_is_bounded_and_carries_actionable_session_facts() {
        let observations = vec![
            (
                "gameplay",
                WorkPackageStatus::Running,
                Some("s_gameplay"),
                Some(SessionStatus::Idle),
            ),
            (
                "ui",
                WorkPackageStatus::Running,
                Some("s_ui"),
                Some(SessionStatus::Running),
            ),
        ];
        let prompt = wake_prompt(&observations);
        assert!(prompt.contains("process every actionable item in this batch"));
        assert!(
            prompt.contains("gameplay: package=Running, session=s_gameplay, sessionStatus=Idle")
        );
        assert!(prompt.contains("ui: package=Running, session=s_ui, sessionStatus=Running"));
        assert!(!prompt.contains("inspect the exact bound WorkSessions and Git evidence"));
    }

    #[test]
    fn terminal_workflow_runs_do_not_treat_retained_packages_as_active_work() {
        assert!(run_has_active_work(
            Some(crate::pm_domain::dcg::DcgRunStatus::Active),
            false
        ));
        assert!(!run_has_active_work(
            Some(crate::pm_domain::dcg::DcgRunStatus::Completed),
            true
        ));
        assert!(!run_has_active_work(
            Some(crate::pm_domain::dcg::DcgRunStatus::Cancelled),
            true
        ));
        assert!(run_has_active_work(None, true));
    }
}
