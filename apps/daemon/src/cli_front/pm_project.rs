//! PM-only project control commands.
//!
//! The caller never supplies a controller or project root. Both are derived
//! from the daemon-authenticated PM session so an Agent process cannot manage
//! another project by changing a flag or its current directory.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use genehub_proto::{SessionKind, SessionStatus, WorkspaceKind};
use serde_json::json;

use crate::pm_domain::dcg::DcgActor;
use crate::pm_domain::project::{ProjectLifecycle, ProjectPhase};
use crate::pm_domain::task_graph::{
    CandidateEvidence, ReviewEvidence, ReviewVerdict, WorkPackage, WorkPackageStatus,
};
use crate::pm_domain::topology::AgentSpaceRole;

use super::output::{self, CliFailure};

const RUNNING_MANAGER_DIRECTIVE: &str = "Do not sleep, poll, or keep this PM turn open. Create or continue owned WorkSessions only with a top-level GeneHub CLI command using --no-wait; never wrap it in timeout, a pipe, or another waiting construct. Dispatch and bind any other currently-ready independent packages, report briefly, then finish the turn; the daemon supervisor will wake the PM on material WorkSession changes.";

pub async fn run(args: &[String]) -> i32 {
    match execute(args).await {
        Ok((kind, data)) => output::succeed(kind, data),
        Err(error) => output::fail(error),
    }
}

async fn execute(args: &[String]) -> Result<(&'static str, serde_json::Value), CliFailure> {
    let context = Context::load().await?;
    match args {
        [verb] if verb == "init" => {
            let project = context
                .state
                .projects
                .initialize(
                    &context.workspace_id,
                    &context.controller_session_id,
                    &context.root,
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "initialized", "project": project})))
        }
        [verb] if verb == "show" => {
            let project = context.project().await?;
            Ok(("pm.project", json!({"action": "shown", "project": project})))
        }
        [head, verb, rest @ ..] if head == "intent" && verb == "set" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&[
                "outcome",
                "acceptance",
                "constraint",
                "out-of-scope",
                "affects",
            ])?;
            let project = context
                .state
                .projects
                .set_intent(
                    &context.workspace_id,
                    &context.controller_session_id,
                    flags.one_required("outcome")?,
                    flags.many_required("acceptance")?,
                    flags.many("constraint"),
                    flags.many("out-of-scope"),
                    flags.many("affects"),
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "intentSet", "project": project})))
        }
        [verb, rest @ ..] if verb == "advance" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["to"])?;
            let raw = flags.one_required("to")?;
            let phase = ProjectPhase::parse(&raw).ok_or_else(|| {
                CliFailure::invalid_args(
                    "--to must be preflight-passed, git-ready, topology-verified, workspaces-registered, or active",
                )
            })?;
            let project = context
                .state
                .projects
                .advance(&context.workspace_id, &context.controller_session_id, phase)
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "advanced", "project": project})))
        }
        [verb, rest @ ..] if verb == "lifecycle" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["to"])?;
            let raw = flags.one_required("to")?;
            let lifecycle = ProjectLifecycle::parse(&raw).ok_or_else(|| {
                CliFailure::invalid_args(
                    "--to must be active, waiting-user, completed, or cancelled",
                )
            })?;
            let project = context
                .state
                .projects
                .set_lifecycle(
                    &context.workspace_id,
                    &context.controller_session_id,
                    lifecycle,
                )
                .await
                .map_err(rejected)?;
            Ok((
                "pm.project",
                json!({"action": "lifecycleSet", "project": project}),
            ))
        }
        [head, verb, rest @ ..] if head == "package" && verb == "put" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&[
                "id",
                "title",
                "outcome",
                "depends-on",
                "space-tag",
                "repository",
                "branch",
                "node",
            ])?;
            let repository_name = flags.one_required("repository")?;
            let repositories_root = context
                .root
                .join("repositories")
                .canonicalize()
                .map_err(rejected)?;
            let repository = exact_project_child(
                &context.root.join("repositories"),
                &repository_name,
                "package repository",
            )?
            .canonicalize()
            .map_err(rejected)?;
            if repository.parent() != Some(repositories_root.as_path()) {
                return Err(CliFailure::business(
                    "invalidPackageRepository",
                    "package repository must be directly under project repositories/",
                    None,
                ));
            }
            let repository_name = repository
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| {
                    CliFailure::business(
                        "invalidPackageRepository",
                        "package repository name must be UTF-8",
                        None,
                    )
                })?
                .to_string();
            // Package creation is the allocation boundary. The Coordinator
            // replaces this placeholder with worktrees/<selected-space>/<repo>
            // atomically; the PM creates that returned worktree before Ready.
            let worktree = context
                .root
                .join("worktrees/coordinator-pending")
                .join(&repository_name);
            let mut package = WorkPackage::planned(
                flags.one_required("id")?,
                flags.one_required("title")?,
                flags.one_required("outcome")?,
                flags.many("depends-on"),
                "coordinator-pending".into(),
                flags.one_required("branch")?,
                worktree,
                chrono::Utc::now().timestamp_millis(),
            )
            .map_err(rejected)?;
            package
                .require_space_tags(flags.many("space-tag"))
                .map_err(rejected)?;
            let project = context
                .state
                .projects
                .put_work_package(
                    &context.workspace_id,
                    &context.controller_session_id,
                    package,
                    &flags.one_required("node")?,
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "packagePut", "project": project})))
        }
        [head, verb, rest @ ..] if head == "package" && verb == "transition" => {
            transition(&context, rest).await
        }
        [head, verb, rest @ ..] if head == "space" && verb == "record" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["name", "purpose", "path", "workspace", "commit", "role", "tag"])?;
            let name = flags.one_required("name")?;
            let purpose = flags.one_required("purpose")?;
            let source = project_path(&context.root, &flags.one_required("path")?)?;
            let workspace_id = flags.one_required("workspace")?;
            let source_commit = flags.one_required("commit")?;
            let role = match flags.one("role")?.as_deref() {
                None | Some("implementation") => AgentSpaceRole::Implementation,
                Some("review") => AgentSpaceRole::Review,
                Some(_) => {
                    return Err(CliFailure::invalid_args(
                        "--role must be implementation or review",
                    ))
                }
            };
            context
                .validate_agent_space(&workspace_id, &source, &name)
                .await?;
            crate::git::verify_clean_project_sources_at_commit(
                &context.root,
                &source_commit,
                &source,
            )
            .await
            .map_err(rejected)?;
            let project = context
                .state
                .projects
                .record_agent_space(
                    &context.workspace_id,
                    &context.controller_session_id,
                    name,
                    purpose,
                    source,
                    workspace_id,
                    source_commit,
                    role,
                    flags.many("tag"),
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "spaceRecorded", "project": project})))
        }
        [head, verb, rest @ ..] if head == "space" && verb == "repair" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["name"])?;
            let project = context
                .state
                .projects
                .repair_agent_space(
                    &context.workspace_id,
                    &context.controller_session_id,
                    &flags.one_required("name")?,
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "spaceRepaired", "project": project})))
        }
        [head, verb] if head == "workflow" && verb == "list" => {
            let catalog = context
                .state
                .projects
                .session_dcg_catalog(&context.workspace_id, &context.controller_session_id)
                .await
                .map_err(rejected)?;
            Ok((
                "pm.project.workflow",
                json!({
                    "action": "listed",
                    "recommended": catalog.recommended_session_workflow,
                    "sessionWorkflows": catalog.session_workflows.values().map(|graph| json!({
                        "id": graph.id,
                        "version": graph.version,
                        "entry": graph.entry,
                    })).collect::<Vec<_>>(),
                }),
            ))
        }
        [head, verb] if head == "workflow" && verb == "show" => {
            let project = context.project().await?;
            let run = project
                .session_dcg_runs
                .get(&context.controller_session_id)
                .ok_or_else(|| {
                    CliFailure::business(
                        "pmWorkflowRunUnavailable",
                        "this PM Session has no Session DCG Run",
                        None,
                    )
                })?;
            Ok((
                "pm.project.workflow",
                json!({"action": "shown", "run": run}),
            ))
        }
        [head, verb] if head == "workflow" && verb == "status" => {
            let status = context
                .state
                .projects
                .controller_status(&context.workspace_id, &context.controller_session_id)
                .await
                .map_err(rejected)?;
            let run = status
                .workflow_runs
                .iter()
                .find(|run| {
                    run.controller_session_id.as_deref()
                        == Some(context.controller_session_id.as_str())
                })
                .cloned()
                .ok_or_else(|| {
                    CliFailure::business(
                        "pmWorkflowRunUnavailable",
                        "this PM Session has no Session DCG Run",
                        None,
                    )
                })?;
            let work_packages = status
                .work_packages
                .iter()
                .filter(|package| {
                    package.controller_session_id == context.controller_session_id
                })
                .cloned()
                .collect::<Vec<_>>();
            let agent_spaces = status
                .agent_spaces
                .iter()
                .map(|space| {
                    json!({
                        "name": space.name,
                        "workspaceId": space.workspace_id,
                        "role": space.role,
                        "tags": space.tags,
                        "active": space.active,
                        "resourceState": space.resource_state,
                        "resourceRevision": space.resource_revision,
                        "workPackageId": space.work_package_id,
                        "workSessionId": space.work_session_id,
                    })
                })
                .collect::<Vec<_>>();
            Ok((
                "pm.project.workflow",
                json!({
                    "action": "status",
                    "project": {
                        "workspaceId": status.workspace_id,
                        "phase": status.phase,
                        "lifecycle": status.lifecycle,
                        "revision": status.revision,
                        "updatedAtMs": status.updated_at_ms,
                    },
                    "run": run,
                    "workPackages": work_packages,
                    "agentSpaces": agent_spaces,
                }),
            ))
        }
        [head, verb, rest @ ..] if head == "workflow" && verb == "select" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["graph"])?;
            let project = context
                .state
                .projects
                .select_session_dcg(
                    &context.workspace_id,
                    &context.controller_session_id,
                    &flags.one_required("graph")?,
                )
                .await
                .map_err(rejected)?;
            Ok((
                "pm.project.workflow",
                json!({"action": "selected", "project": project}),
            ))
        }
        [head, verb, rest @ ..] if head == "workflow" && verb == "transition" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["edge", "fact"])?;
            let project = context
                .state
                .projects
                .transition_session_dcg(
                    &context.workspace_id,
                    &context.controller_session_id,
                    &flags.one_required("edge")?,
                    flags.many("fact").into_iter().collect(),
                    DcgActor::Pm,
                )
                .await
                .map_err(rejected)?;
            Ok((
                "pm.project.workflow",
                json!({"action": "transitioned", "project": project}),
            ))
        }
        [head, verb, rest @ ..] if head == "improvement" && verb == "propose" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["id", "target", "rationale"])?;
            let project = context.state.projects.propose_improvement(
                &context.workspace_id,
                &context.controller_session_id,
                flags.one_required("id")?,
                flags.one_required("target")?,
                flags.one_required("rationale")?,
            ).await.map_err(rejected)?;
            Ok(("pm.project.improvement", json!({"action": "proposed", "project": project})))
        }
        [head, verb, rest @ ..] if head == "improvement" && verb == "review" => {
            let flags = Flags::parse(rest, &["pass"])?;
            flags.validate(&["id", "session", "evidence"])?;
            let project = context.state.projects.review_improvement(
                &context.workspace_id,
                &context.controller_session_id,
                &flags.one_required("id")?,
                flags.one_required("session")?,
                flags.one_required("evidence")?,
                flags.has("pass"),
            ).await.map_err(rejected)?;
            Ok(("pm.project.improvement", json!({"action": "reviewed", "project": project})))
        }
        [head, verb, rest @ ..] if head == "improvement" && verb == "promote" => {
            let flags = Flags::parse(rest, &[])?;
            flags.validate(&["id"])?;
            let project = context.state.projects.promote_improvement(
                &context.workspace_id,
                &context.controller_session_id,
                &flags.one_required("id")?,
            ).await.map_err(rejected)?;
            Ok(("pm.project.improvement", json!({"action": "promoted", "project": project})))
        }
        [verb, rest @ ..] if verb == "observe" => {
            let flags = Flags::parse(rest, &["active-work", "waiting-user", "terminal"])?;
            flags.validate(&["digest"])?;
            let observation = context
                .state
                .projects
                .observe(
                    &context.workspace_id,
                    &context.controller_session_id,
                    flags.one_required("digest")?,
                    flags.has("active-work"),
                    flags.has("waiting-user"),
                    flags.has("terminal"),
                )
                .await
                .map_err(rejected)?;
            Ok(("pm.project", json!({"action": "observed", "observation": observation})))
        }
        _ => Err(CliFailure::invalid_args(
            "usage: genet pm project init|show|advance|lifecycle|observe | intent set | package put|transition | space record|repair | workflow list|show|select|transition | improvement propose|review|promote",
        )),
    }
}

async fn transition(
    context: &Context,
    args: &[String],
) -> Result<(&'static str, serde_json::Value), CliFailure> {
    let flags = Flags::parse(args, &[])?;
    flags.validate(&[
        "id",
        "to",
        "session",
        "repository",
        "commit",
        "tree",
        "evidence",
        "review-session",
        "candidate-commit",
        "candidate-tree",
        "verdict",
        "review-evidence",
        "reason",
    ])?;
    let id = flags.one_required("id")?;
    let raw_status = flags.one_required("to")?;
    let status = WorkPackageStatus::parse(&raw_status)
        .ok_or_else(|| CliFailure::invalid_args("unknown work package status"))?;
    let session_id = flags.one("session")?;
    let candidate = candidate_from(&flags)?;
    let review = review_from(&flags)?;

    if status == WorkPackageStatus::Ready {
        let project = context.project().await?;
        let package = project.work_packages.get(&id).ok_or_else(|| {
            CliFailure::business(
                "unknownWorkPackage",
                format!("no such work package: {id}"),
                None,
            )
        })?;
        context.validate_package_worktree(package).await?;
    }

    if status == WorkPackageStatus::Candidate {
        let candidate = candidate.as_ref().ok_or_else(|| {
            CliFailure::invalid_args(
                "candidate status requires --repository, --commit, --tree, and --evidence",
            )
        })?;
        context.validate_candidate(&id, candidate).await?;
    }

    // Review and acceptance are facts about the same immutable Git
    // candidate, not merely matching strings copied from an older command.
    // Re-run the exact clean HEAD/tree gate before both transitions so a
    // reviewer or ordinary session cannot edit the worktree and still pass.
    if matches!(
        status,
        WorkPackageStatus::Review | WorkPackageStatus::Accepted
    ) {
        let project = context.project().await?;
        let candidate = project
            .work_packages
            .get(&id)
            .and_then(|package| package.candidate.as_ref())
            .ok_or_else(|| {
                CliFailure::business(
                    "candidateRequired",
                    "review or acceptance requires a recorded candidate",
                    None,
                )
            })?;
        context.validate_candidate(&id, candidate).await?;
    }

    if status == WorkPackageStatus::Running {
        let session = session_id.as_deref().ok_or_else(|| {
            CliFailure::invalid_args("running a package requires --session <WorkSession id>")
        })?;
        context.validate_work_session(session, &id, None).await?;
    }

    if let Some(review) = review.as_ref() {
        let project = context.project().await?;
        let implementation_session = project
            .work_packages
            .get(&id)
            .and_then(|package| package.work_session_id.as_deref());
        context
            .validate_work_session(&review.session_id, &id, implementation_session)
            .await?;
    }

    if status == WorkPackageStatus::Accepted {
        let project = context.project().await?;
        let implementation_session = project
            .work_packages
            .get(&id)
            .and_then(|package| package.work_session_id.as_deref());
        let review_session = review
            .as_ref()
            .or_else(|| {
                project
                    .work_packages
                    .get(&id)
                    .and_then(|package| package.review.as_ref())
            })
            .map(|evidence| evidence.session_id.as_str())
            .ok_or_else(|| {
                CliFailure::business(
                    "independentReviewRequired",
                    "acceptance requires an independent Review WorkSession",
                    None,
                )
            })?;
        context
            .validate_work_session(review_session, &id, implementation_session)
            .await?;
        let summary = context
            .state
            .sessions
            .summary(review_session)
            .await
            .map_err(rejected)?;
        if summary.status != SessionStatus::Idle {
            return Err(CliFailure::business(
                "reviewNotComplete",
                "a passing review can be accepted only after its WorkSession completes successfully",
                Some(json!({"sessionId": review_session, "status": summary.status})),
            ));
        }
    }

    let project = context
        .state
        .projects
        .transition_work_package(
            &context.workspace_id,
            &context.controller_session_id,
            &id,
            status,
            session_id,
            candidate,
            review,
            flags.one("reason")?,
        )
        .await
        .map_err(rejected)?;
    Ok(("pm.project", transition_output(status, project)))
}

fn transition_output(
    status: WorkPackageStatus,
    project: crate::pm_domain::project::ProjectState,
) -> serde_json::Value {
    if status == WorkPackageStatus::Running {
        json!({
            "action": "packageTransitioned",
            "project": project,
            "managerDirective": {
                "action": "finishTurnAfterReadyDispatches",
                "monitor": "daemonSupervisor",
                "instruction": RUNNING_MANAGER_DIRECTIVE,
            },
        })
    } else {
        json!({"action": "packageTransitioned", "project": project})
    }
}

fn candidate_from(flags: &Flags) -> Result<Option<CandidateEvidence>, CliFailure> {
    let fields = [
        flags.one("repository")?,
        flags.one("commit")?,
        flags.one("tree")?,
    ];
    if fields.iter().all(Option::is_none) {
        return Ok(None);
    }
    let [repository, commit, tree] = fields;
    Ok(Some(CandidateEvidence {
        repository: repository
            .ok_or_else(|| CliFailure::invalid_args("candidate evidence requires --repository"))?,
        commit: commit
            .ok_or_else(|| CliFailure::invalid_args("candidate evidence requires --commit"))?,
        tree: tree.ok_or_else(|| CliFailure::invalid_args("candidate evidence requires --tree"))?,
        evidence: flags.many("evidence"),
    }))
}

fn review_from(flags: &Flags) -> Result<Option<ReviewEvidence>, CliFailure> {
    let session_id = flags.one("review-session")?;
    let commit = flags.one("candidate-commit")?;
    let tree = flags.one("candidate-tree")?;
    let verdict = flags.one("verdict")?;
    if session_id.is_none() && commit.is_none() && tree.is_none() && verdict.is_none() {
        return Ok(None);
    }
    let verdict = match verdict.as_deref() {
        None => None,
        Some("pass") => Some(ReviewVerdict::Pass),
        Some("fail") => Some(ReviewVerdict::Fail),
        Some(_) => return Err(CliFailure::invalid_args("--verdict must be pass or fail")),
    };
    Ok(Some(ReviewEvidence {
        session_id: session_id
            .ok_or_else(|| CliFailure::invalid_args("review evidence requires --review-session"))?,
        candidate_commit: commit.ok_or_else(|| {
            CliFailure::invalid_args("review evidence requires --candidate-commit")
        })?,
        candidate_tree: tree
            .ok_or_else(|| CliFailure::invalid_args("review evidence requires --candidate-tree"))?,
        verdict,
        evidence: flags.many("review-evidence"),
    }))
}

pub(super) struct Context {
    pub(super) state: crate::state::Shared,
    pub(super) controller_session_id: String,
    pub(super) workspace_id: String,
    pub(super) root: PathBuf,
}

impl Context {
    pub(super) async fn load() -> Result<Self, CliFailure> {
        let state = super::local_state()
            .map_err(|message| CliFailure::business("pmProjectUnavailable", message, None))?;
        let principal = super::caller_principal()
            .map_err(|message| CliFailure::business("pmProjectUnavailable", message, None))?;
        let controller_session_id = principal
            .project_manager_session_id()
            .map(str::to_string)
            .ok_or_else(|| {
                CliFailure::business(
                    "projectManagerRequired",
                    "PM project control is available only inside its authenticated PM Agent session",
                    None,
                )
            })?;
        let summary = state
            .sessions
            .summary(&controller_session_id)
            .await
            .map_err(rejected)?;
        if summary.kind != Some(SessionKind::Pm) {
            return Err(CliFailure::business(
                "projectManagerRequired",
                "the authenticated controller is not a PM Agent session",
                None,
            ));
        }
        let session_workspace = state
            .workspaces
            .get(&summary.workspace_id)
            .await
            .map_err(rejected)?;
        let workspace = match session_workspace.kind {
            WorkspaceKind::Folder => session_workspace,
            WorkspaceKind::AgentSpace => {
                let binding = session_workspace.agent_space.as_ref().ok_or_else(|| {
                    CliFailure::business(
                        "invalidProjectWorkspace",
                        "the PM AgentSpace has no project binding",
                        None,
                    )
                })?;
                state
                    .workspaces
                    .get(&binding.project_workspace_id)
                    .await
                    .map_err(rejected)?
            }
            WorkspaceKind::PipeSpace => {
                return Err(CliFailure::business(
                    "invalidProjectWorkspace",
                    "a PM Session must run in its PM AgentSpace",
                    None,
                ));
            }
        };
        if workspace.kind != WorkspaceKind::Folder {
            return Err(CliFailure::business(
                "invalidProjectWorkspace",
                "the PM AgentSpace must belong to a Folder project workspace",
                None,
            ));
        }
        Ok(Self {
            state,
            controller_session_id,
            workspace_id: workspace.id,
            root: workspace.root,
        })
    }

    pub(super) async fn project(
        &self,
    ) -> Result<crate::pm_domain::project::ProjectState, CliFailure> {
        self.state
            .projects
            .get(&self.workspace_id, &self.controller_session_id)
            .await
            .map_err(rejected)
    }

    async fn validate_work_session(
        &self,
        session_id: &str,
        expected_package: &str,
        must_differ_from: Option<&str>,
    ) -> Result<(), CliFailure> {
        if must_differ_from == Some(session_id) {
            return Err(CliFailure::business(
                "independentReviewRequired",
                "a package implementation WorkSession cannot review its own candidate",
                None,
            ));
        }
        let summary = self
            .state
            .sessions
            .summary(session_id)
            .await
            .map_err(rejected)?;
        let Some(work) = summary
            .work
            .as_ref()
            .filter(|_| summary.kind == Some(SessionKind::Work))
        else {
            return Err(CliFailure::business(
                "workSessionRequired",
                format!("session {session_id} is not a WorkSession"),
                None,
            ));
        };
        if work.controller_session_id != self.controller_session_id {
            return Err(CliFailure::business(
                "wrongProjectController",
                format!("WorkSession {session_id} belongs to another PM project"),
                None,
            ));
        }
        let project = self.project().await?;
        let space = project
            .agent_spaces
            .values()
            .find(|space| space.active && space.workspace_id == summary.workspace_id)
            .ok_or_else(|| {
                CliFailure::business(
                    "agentSpaceNotRecorded",
                    format!("WorkSession {session_id} has no active recorded Agent Space"),
                    None,
                )
            })?;
        crate::pm_domain::verify_recorded_agent_space(&project, space)
            .await
            .map_err(rejected)?;
        if work.work_package_id != expected_package {
            return Err(CliFailure::business(
                "wrongWorkPackage",
                format!("WorkSession {session_id} is not bound to package {expected_package}",),
                None,
            ));
        }
        if let Some(implementation_session_id) = must_differ_from {
            let implementation = self
                .state
                .sessions
                .summary(implementation_session_id)
                .await
                .map_err(rejected)?;
            if implementation.workspace_id == summary.workspace_id {
                return Err(CliFailure::business(
                    "independentReviewRequired",
                    "an independent review WorkSession must run in a different Agent Space",
                    None,
                ));
            }
        }
        Ok(())
    }

    async fn validate_agent_space(
        &self,
        workspace_id: &str,
        source: &Path,
        expected_name: &str,
    ) -> Result<(), CliFailure> {
        let source = source.canonicalize().map_err(rejected)?;
        let workspace = self
            .state
            .workspaces
            .get(workspace_id)
            .await
            .map_err(rejected)?;
        let binding = workspace
            .agent_space
            .as_ref()
            .filter(|_| workspace.kind == WorkspaceKind::AgentSpace)
            .ok_or_else(|| {
                CliFailure::business(
                    "agentSpaceRequired",
                    format!("workspace {workspace_id} is not a registered Agent Space"),
                    None,
                )
            })?;
        if binding.project_workspace_id != self.workspace_id {
            return Err(CliFailure::business(
                "wrongProjectController",
                "the Agent Space belongs to another project",
                None,
            ));
        }
        if workspace.root.canonicalize().map_err(rejected)? != source {
            return Err(CliFailure::business(
                "wrongAgentSpaceSource",
                "the Agent Space workspace root does not match --path",
                None,
            ));
        }
        let expected_workspace = source.join(format!("{expected_name}.code-workspace"));
        let registered_workspace = workspace
            .workspace_file
            .as_ref()
            .ok_or_else(|| rejected("registered Agent Space has no workspace source"))?
            .canonicalize()
            .map_err(rejected)?;
        if registered_workspace != expected_workspace.canonicalize().map_err(rejected)? {
            return Err(CliFailure::business(
                "wrongAgentSpaceSource",
                "the recorded name/path do not match the registered Agent Space workspace file",
                None,
            ));
        }
        Ok(())
    }

    async fn validate_package_worktree(&self, package: &WorkPackage) -> Result<(), CliFailure> {
        let worktrees = self
            .root
            .join("worktrees")
            .canonicalize()
            .map_err(rejected)?;
        let worktree = package.worktree.canonicalize().map_err(rejected)?;
        let relative = worktree.strip_prefix(&worktrees).map_err(rejected)?;
        let parts = relative.components().collect::<Vec<_>>();
        if parts.len() != 2 {
            return Err(CliFailure::business(
                "invalidPackageWorktree",
                "package worktree must be worktrees/<coordinator-selected-space>/<repository>",
                None,
            ));
        }
        let repository_name = parts[1].as_os_str().to_str().ok_or_else(|| {
            CliFailure::business(
                "invalidPackageWorktree",
                "package repository name must be UTF-8",
                None,
            )
        })?;
        if repository_name != package.repository {
            return Err(CliFailure::business(
                "invalidPackageWorktree",
                "package worktree repository does not match its durable repository identity",
                None,
            ));
        }
        let repository = self.root.join("repositories").join(repository_name);
        crate::git::verify_worktree_binding(&worktree, &repository, &package.branch)
            .await
            .map_err(rejected)
    }

    async fn validate_candidate(
        &self,
        package_id: &str,
        candidate: &CandidateEvidence,
    ) -> Result<(), CliFailure> {
        let project = self.project().await?;
        let package = project.work_packages.get(package_id).ok_or_else(|| {
            CliFailure::business(
                "unknownWorkPackage",
                format!("no such work package: {package_id}"),
                None,
            )
        })?;
        let repository = exact_project_child(
            &self.root.join("repositories"),
            &candidate.repository,
            "candidate repository",
        )?;
        crate::git::verify_worktree_candidate(
            &package.worktree,
            &repository,
            &package.branch,
            &candidate.commit,
            &candidate.tree,
        )
        .await
        .map_err(rejected)
    }
}

fn rejected(error: impl std::fmt::Display) -> CliFailure {
    CliFailure::business("pmProjectRejected", error.to_string(), None)
}

fn project_path(root: &Path, value: &str) -> Result<PathBuf, CliFailure> {
    let supplied = Path::new(value);
    if value.trim().is_empty()
        || supplied
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(CliFailure::invalid_args(
            "project paths must be non-empty and cannot contain ..",
        ));
    }
    let path = if supplied.is_absolute() {
        supplied.to_path_buf()
    } else {
        root.join(supplied)
    };
    if !path.starts_with(root) {
        return Err(CliFailure::business(
            "pathOutsideProject",
            format!("{} is outside the PM project", path.display()),
            None,
        ));
    }
    Ok(path)
}

fn exact_project_child(root: &Path, value: &str, label: &str) -> Result<PathBuf, CliFailure> {
    let supplied = Path::new(value);
    if value.trim().is_empty()
        || supplied.is_absolute()
        || supplied.components().count() != 1
        || !matches!(supplied.components().next(), Some(Component::Normal(_)))
    {
        return Err(CliFailure::invalid_args(format!(
            "{label} must be one exact directory name"
        )));
    }
    Ok(root.join(supplied))
}

#[derive(Debug, Default)]
struct Flags {
    values: BTreeMap<String, Vec<String>>,
    switches: BTreeSet<String>,
    positionals: Vec<String>,
}

impl Flags {
    fn parse(args: &[String], switches: &[&str]) -> Result<Self, CliFailure> {
        let switches: BTreeSet<_> = switches.iter().copied().collect();
        let mut parsed = Self::default();
        let mut index = 0;
        while index < args.len() {
            let argument = &args[index];
            let Some(name) = argument.strip_prefix("--") else {
                parsed.positionals.push(argument.clone());
                index += 1;
                continue;
            };
            if name.is_empty() {
                return Err(CliFailure::invalid_args("empty flag name"));
            }
            if switches.contains(name) {
                if !parsed.switches.insert(name.to_string()) {
                    return Err(CliFailure::invalid_args(format!(
                        "--{name} may be passed only once"
                    )));
                }
                index += 1;
                continue;
            }
            let value = args.get(index + 1).filter(|value| !value.starts_with("--"));
            let Some(value) = value else {
                return Err(CliFailure::invalid_args(format!("--{name} needs a value")));
            };
            parsed
                .values
                .entry(name.to_string())
                .or_default()
                .push(value.clone());
            index += 2;
        }
        Ok(parsed)
    }

    fn validate(&self, allowed_values: &[&str]) -> Result<(), CliFailure> {
        if let Some(argument) = self.positionals.first() {
            return Err(CliFailure::invalid_args(format!(
                "unexpected argument: {}",
                argument
            )));
        }
        let allowed_values: BTreeSet<_> = allowed_values.iter().copied().collect();
        if let Some(name) = self
            .values
            .keys()
            .find(|name| !allowed_values.contains(name.as_str()))
        {
            return Err(CliFailure::invalid_args(format!("unknown option --{name}")));
        }
        Ok(())
    }

    fn one(&self, name: &str) -> Result<Option<String>, CliFailure> {
        match self.values.get(name).map(Vec::as_slice) {
            None => Ok(None),
            Some([value]) => Ok(Some(value.clone())),
            Some(_) => Err(CliFailure::invalid_args(format!(
                "--{name} may be passed only once"
            ))),
        }
    }

    fn one_required(&self, name: &str) -> Result<String, CliFailure> {
        self.one(name)?.ok_or_else(|| {
            CliFailure::invalid_args(format!("this command requires --{name} <value>"))
        })
    }

    fn many(&self, name: &str) -> Vec<String> {
        self.values.get(name).cloned().unwrap_or_default()
    }

    fn many_required(&self, name: &str) -> Result<Vec<String>, CliFailure> {
        let values = self.many(name);
        if values.is_empty() {
            Err(CliFailure::invalid_args(format!(
                "this command requires at least one --{name} <value>"
            )))
        } else {
            Ok(values)
        }
    }

    fn has(&self, name: &str) -> bool {
        self.switches.contains(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn repeated_evidence_is_preserved_but_singletons_are_rejected() {
        let flags = Flags::parse(
            &words(&[
                "--id",
                "gameplay",
                "--evidence",
                "cargo test",
                "--evidence",
                "demo sha256:x",
            ]),
            &[],
        )
        .unwrap();
        assert_eq!(flags.one("id").unwrap().as_deref(), Some("gameplay"));
        assert_eq!(flags.many("evidence").len(), 2);

        let duplicate = Flags::parse(&words(&["--id", "a", "--id", "b"]), &[]).unwrap();
        assert!(duplicate.one("id").is_err());
    }

    #[test]
    fn project_paths_reject_parent_traversal() {
        let root = Path::new("/project");
        assert_eq!(
            project_path(root, "worktrees/code/repo").unwrap(),
            PathBuf::from("/project/worktrees/code/repo")
        );
        assert!(project_path(root, "worktrees/../secrets").is_err());
        assert!(project_path(root, "/outside").is_err());
    }

    #[test]
    fn running_transition_tells_the_manager_to_yield_to_the_supervisor() {
        let project = crate::pm_domain::project::ProjectState::new(
            "workspace".into(),
            "controller".into(),
            PathBuf::from("/project"),
            1,
        );
        let payload = transition_output(WorkPackageStatus::Running, project);
        assert_eq!(
            payload["managerDirective"]["action"],
            "finishTurnAfterReadyDispatches"
        );
        assert_eq!(payload["managerDirective"]["monitor"], "daemonSupervisor");
        assert!(payload["managerDirective"]["instruction"]
            .as_str()
            .unwrap()
            .contains("Do not sleep"));
    }
}
