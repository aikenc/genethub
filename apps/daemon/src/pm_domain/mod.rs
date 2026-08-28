//! Durable project-management facts owned by the daemon guest.
//!
//! Agent Space topology itself stays in the project's Git repository. This
//! store only keeps the controller, Intent/DAG state, immutable references,
//! and the next supervisor check needed to recover a PM turn.

pub mod project;
pub mod runtime;
pub mod supervisor;
pub mod task_graph;
pub mod topology;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use genehub_proto::{
    PmAgentSpaceStatus, PmIntentStatus, PmProjectStatus, PmSupervisorStatus, PmWorkPackageStatus,
};
use project::{IntentRevision, ProjectLifecycle, ProjectPhase, ProjectState, PM_PROJECT_FORMAT};
use serde::Serialize;
use supervisor::WakeDispatchOutcome;
use task_graph::{
    validate_graph, CandidateEvidence, ReviewEvidence, WorkPackage, WorkPackageStatus,
};
use tokio::sync::Mutex;
use topology::{AgentSpaceRecord, AgentSpaceRole};

/// The durable project fact that authorizes one new managed WorkSession.
/// Its cwd is derived from the work package, never from model-selected input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkDispatchKind {
    Implementation,
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkDispatchTarget {
    pub cwd: PathBuf,
    pub kind: WorkDispatchKind,
}

pub struct ProjectStore {
    root: PathBuf,
    mutation: Mutex<()>,
}

impl ProjectStore {
    pub fn new(data_root: &Path) -> Self {
        Self {
            root: data_root.join("pm-projects"),
            mutation: Mutex::new(()),
        }
    }

    pub async fn initialize(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        project_root: &Path,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        if let Some(existing) = self.load_optional(project_workspace_id)? {
            existing.ensure_controller(controller_session_id)?;
            if existing.root != project_root.canonicalize()? {
                anyhow::bail!("the persisted PM project root no longer matches this workspace");
            }
            return Ok(existing);
        }
        let root = project_root
            .canonicalize()
            .with_context(|| format!("no such PM project root: {}", project_root.display()))?;
        preflight_empty_project(&root)?;
        let state = ProjectState::new(
            project_workspace_id.to_string(),
            controller_session_id.to_string(),
            root,
            now_ms(),
        );
        self.save(&state)?;
        Ok(state)
    }

    pub async fn get(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        Ok(state)
    }

    /// User-visible progress without exposing control authority or physical
    /// state-file paths. Unlike PM control reads, this does not require the
    /// controller identity and cannot mutate anything.
    pub async fn public_status(
        &self,
        project_workspace_id: &str,
    ) -> Result<Option<PmProjectStatus>> {
        let _guard = self.mutation.lock().await;
        self.load_optional(project_workspace_id)?
            .map(|state| project_status(&state))
            .transpose()
    }

    /// Resolve public WorkSession creation against the current Intent/DAG.
    /// Implementers must use their assigned Agent Space; reviewers may start
    /// only after an immutable candidate exists and in another recorded Space.
    pub async fn authorize_work_session(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        agent_space_workspace_id: &str,
        work_package_id: &str,
    ) -> Result<WorkDispatchTarget> {
        let _guard = self.mutation.lock().await;
        let state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.lifecycle != ProjectLifecycle::Active || state.phase != ProjectPhase::Active {
            anyhow::bail!("the PM project is not active for WorkAgent dispatch");
        }
        let package = state
            .work_packages
            .get(work_package_id)
            .ok_or_else(|| anyhow::anyhow!("no such work package: {work_package_id}"))?;
        let space = state
            .agent_spaces
            .values()
            .find(|space| space.active && space.workspace_id == agent_space_workspace_id)
            .ok_or_else(|| {
                anyhow::anyhow!("the target Agent Space is not active in this PM project")
            })?;
        verify_recorded_agent_space(&state, space).await?;

        let kind = match package.status {
            WorkPackageStatus::Ready => {
                if space.role != AgentSpaceRole::Implementation {
                    anyhow::bail!("implementation cannot run in a review-only Agent Space");
                }
                if space.name != package.agent_space {
                    anyhow::bail!(
                        "implementation work package {work_package_id} is assigned to Agent Space {}",
                        package.agent_space
                    );
                }
                if package.work_session_id.is_some() {
                    anyhow::bail!(
                        "implementation work package {work_package_id} already has a WorkSession"
                    );
                }
                WorkDispatchKind::Implementation
            }
            WorkPackageStatus::Candidate => {
                if space.role != AgentSpaceRole::Review {
                    anyhow::bail!("candidate review requires a review-only Agent Space");
                }
                if space.name == package.agent_space {
                    anyhow::bail!(
                        "candidate review requires a different Agent Space from implementation"
                    );
                }
                WorkDispatchKind::Review
            }
            status => anyhow::bail!(
                "work package {work_package_id} is not ready for a new WorkSession ({status:?})"
            ),
        };

        let worktree = package.worktree.canonicalize().with_context(|| {
            format!(
                "work package worktree is unavailable: {}",
                package.worktree.display()
            )
        })?;
        let worktrees_root = state
            .root
            .join("worktrees")
            .canonicalize()
            .context("the PM project has no worktrees directory")?;
        if !is_clean_descendant(&worktree, &worktrees_root) {
            anyhow::bail!("work package worktree escaped the PM project");
        }
        Ok(WorkDispatchTarget {
            cwd: worktree,
            kind,
        })
    }

    pub async fn set_intent(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        outcome: String,
        acceptance: Vec<String>,
        constraints: Vec<String>,
        out_of_scope: Vec<String>,
        affected_work_packages: Vec<String>,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        unique_values("affected work package", &affected_work_packages)?;
        for package_id in &affected_work_packages {
            let package = state
                .work_packages
                .get_mut(package_id)
                .ok_or_else(|| anyhow::anyhow!("no such affected work package: {package_id}"))?;
            if package.status != WorkPackageStatus::Cancelled {
                package.status = WorkPackageStatus::Blocked;
                package.block_reason = Some("invalidated by a newer Intent revision".into());
                package.candidate = None;
                package.review = None;
                package.updated_at_ms = now_ms();
            }
        }
        let revision = state
            .intent
            .as_ref()
            .map_or(1, |intent| intent.revision.saturating_add(1));
        let intent = IntentRevision {
            revision,
            outcome,
            acceptance,
            constraints,
            out_of_scope,
            affected_work_packages,
            recorded_at_ms: now_ms(),
        };
        intent.validate()?;
        state.intent = Some(intent);
        state.touch(now_ms());
        self.save(&state)?;
        Ok(state)
    }

    pub async fn advance(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        phase: ProjectPhase,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        validate_phase_evidence(&state, phase)?;
        state.advance(phase, now_ms())?;
        self.save(&state)?;
        Ok(state)
    }

    pub async fn put_work_package(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        mut package: WorkPackage,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        if !state
            .agent_spaces
            .get(&package.agent_space)
            .is_some_and(|space| space.active && space.role == AgentSpaceRole::Implementation)
        {
            anyhow::bail!("work package requires an active implementation Agent Space");
        }
        let worktrees_root = state
            .root
            .join("worktrees")
            .canonicalize()
            .context("the PM project has no worktrees directory")?;
        let worktree = package
            .worktree
            .canonicalize()
            .with_context(|| format!("no such package worktree: {}", package.worktree.display()))?;
        if !is_clean_descendant(&worktree, &worktrees_root) {
            anyhow::bail!("work package worktree must stay under the PM project's worktrees/");
        }
        package.worktree = worktree;
        if let Some(existing) = state.work_packages.get(&package.id) {
            if !matches!(
                existing.status,
                WorkPackageStatus::Planned | WorkPackageStatus::Blocked
            ) {
                anyhow::bail!("an active or completed work package cannot be redefined");
            }
            package.status = existing.status;
            package.block_reason = existing.block_reason.clone();
        }
        let mut next = state.work_packages.clone();
        next.insert(package.id.clone(), package);
        validate_graph(&next)?;
        state.work_packages = next;
        state.touch(now_ms());
        self.save(&state)?;
        Ok(state)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn transition_work_package(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        id: &str,
        status: WorkPackageStatus,
        work_session_id: Option<String>,
        candidate: Option<CandidateEvidence>,
        review: Option<ReviewEvidence>,
        block_reason: Option<String>,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        if matches!(
            status,
            WorkPackageStatus::Candidate | WorkPackageStatus::Review | WorkPackageStatus::Accepted
        ) {
            let package = state
                .work_packages
                .get(id)
                .ok_or_else(|| anyhow::anyhow!("no such work package: {id}"))?;
            let space = state
                .agent_spaces
                .get(&package.agent_space)
                .filter(|space| space.active)
                .ok_or_else(|| {
                    anyhow::anyhow!("work package {id} has no active implementation Agent Space")
                })?;
            verify_recorded_agent_space(&state, space).await?;
        }
        task_graph::transition(
            &mut state.work_packages,
            id,
            status,
            work_session_id,
            candidate,
            review,
            block_reason,
            now_ms(),
        )?;
        state.touch(now_ms());
        self.save(&state)?;
        Ok(state)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn record_agent_space(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        name: String,
        purpose: String,
        source_path: PathBuf,
        workspace_id: String,
        source_commit: String,
        role: AgentSpaceRole,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        validate_kebab_name(&name)?;
        if purpose.trim().is_empty() || purpose.len() > 2_000 {
            anyhow::bail!("Agent Space purpose must be 1-2000 characters");
        }
        if workspace_id.trim().is_empty() {
            anyhow::bail!("Agent Space workspace id is required");
        }
        validate_git_object(&source_commit)?;
        let source_path = source_path
            .canonicalize()
            .with_context(|| format!("no such Agent Space: {}", source_path.display()))?;
        let spaces_root = state
            .root
            .join("spaces")
            .canonicalize()
            .context("the PM project has no spaces directory")?;
        if source_path.parent() != Some(spaces_root.as_path()) {
            anyhow::bail!("Agent Space source must be directly under project spaces/");
        }
        if source_path.file_name().and_then(|value| value.to_str()) != Some(name.as_str()) {
            anyhow::bail!("Agent Space name must match its source directory");
        }
        let verified = crate::agent_space_builder::verify_space(&state.root, &source_path)
            .context("Agent Space Builder verification failed")?;
        if verified.name != name {
            anyhow::bail!("Agent Space name does not match the verified Builder manifest");
        }
        crate::git::verify_clean_project_sources_at_commit(
            &state.root,
            &source_commit,
            &source_path,
        )
        .await
        .context("Agent Space must be recorded from the current clean outer-project HEAD")?;
        if let Some(existing) = state.agent_spaces.get(&name) {
            if existing.source_path != source_path
                || existing.workspace_id != workspace_id
                || existing.role != role
            {
                anyhow::bail!(
                    "a recorded Agent Space cannot change path, workspace, or role; add a new topology node"
                );
            }
        }
        let previous = state.agent_spaces.get(&name).cloned();
        // Every record advances to the current clean outer-project HEAD. A
        // peer Space-only commit does not invalidate this node's package after
        // it is re-recorded; a changed Builder identity does.
        let identity_changed = previous
            .as_ref()
            .is_some_and(|existing| existing.builder_lock_digest != verified.lock_digest);
        let record = AgentSpaceRecord {
            name: name.clone(),
            purpose,
            source_path,
            workspace_id,
            source_commit,
            builder_lock_digest: verified.lock_digest,
            role,
            active: true,
            updated_at_ms: now_ms(),
        };
        state.agent_spaces.insert(name, record);
        if identity_changed {
            for package in state.work_packages.values_mut() {
                let implementation_changed = package.agent_space == previous.as_ref().unwrap().name;
                let active_review_changed =
                    role == AgentSpaceRole::Review && package.status == WorkPackageStatus::Review;
                if (implementation_changed || active_review_changed)
                    && matches!(
                        package.status,
                        WorkPackageStatus::Candidate | WorkPackageStatus::Review
                    )
                {
                    package.status = WorkPackageStatus::Blocked;
                    package.block_reason = Some(
                        "invalidated because a candidate or review Agent Space changed".into(),
                    );
                    package.candidate = None;
                    package.review = None;
                    package.updated_at_ms = now_ms();
                }
            }
        }
        state.touch(now_ms());
        self.save(&state)?;
        Ok(state)
    }

    pub async fn observe(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        digest: String,
        active_work: bool,
        waiting_user: bool,
        terminal: bool,
    ) -> Result<Observation> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        state.ensure_mutable()?;
        if digest.trim().is_empty() || digest.len() > 512 {
            anyhow::bail!("supervisor observation digest must be 1-512 characters");
        }
        let wake_manager =
            state
                .supervisor
                .observe(digest, active_work, waiting_user, terminal, now_ms());
        // This command is called by an already-awake PM turn. It reports
        // whether the fact changed, but must not schedule a duplicate turn.
        state.supervisor.acknowledge_wake();
        state.touch(now_ms());
        self.save(&state)?;
        Ok(Observation {
            project: state,
            wake_manager,
        })
    }

    pub async fn set_lifecycle(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        lifecycle: ProjectLifecycle,
    ) -> Result<ProjectState> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.lifecycle == lifecycle {
            return Ok(state);
        }
        if state.lifecycle == ProjectLifecycle::Cancelled {
            anyhow::bail!("a cancelled PM project is retained and cannot be resumed");
        }
        match lifecycle {
            ProjectLifecycle::Active => {
                if !matches!(
                    state.lifecycle,
                    ProjectLifecycle::WaitingUser | ProjectLifecycle::Completed
                ) {
                    anyhow::bail!("only a waitingUser or completed project can resume to active");
                }
                // `completed` closes one accepted delivery, not the Folder's
                // lifetime. A later explicit user request may reopen the same
                // PM, topology, and Git lineage for a new Intent revision.
                state.supervisor = supervisor::SupervisorState::idle();
            }
            ProjectLifecycle::WaitingUser => {
                state.ensure_mutable()?;
                if has_running_work(&state) {
                    anyhow::bail!("pause running work packages before waiting for the user");
                }
                state.supervisor.observe(
                    format!("lifecycle:waiting-user:{}", state.revision),
                    false,
                    true,
                    false,
                    now_ms(),
                );
            }
            ProjectLifecycle::Completed => {
                state.ensure_mutable()?;
                if state.phase != ProjectPhase::Active || state.work_packages.is_empty() {
                    anyhow::bail!("only an active project with work packages can complete");
                }
                if state.work_packages.values().any(|package| {
                    !matches!(
                        package.status,
                        WorkPackageStatus::Accepted | WorkPackageStatus::Cancelled
                    )
                }) {
                    anyhow::bail!(
                        "all work packages must be accepted or cancelled before completion"
                    );
                }
                state.supervisor.observe(
                    format!("lifecycle:completed:{}", state.revision),
                    false,
                    false,
                    true,
                    now_ms(),
                );
            }
            ProjectLifecycle::Cancelled => {
                state.ensure_mutable()?;
                if has_running_work(&state) {
                    anyhow::bail!(
                        "cancel or block running work packages before cancelling the project"
                    );
                }
                state.supervisor.observe(
                    format!("lifecycle:cancelled:{}", state.revision),
                    false,
                    false,
                    true,
                    now_ms(),
                );
            }
        }
        state.lifecycle = lifecycle;
        state.touch(now_ms());
        self.save(&state)?;
        Ok(state)
    }

    /// Recover every durable PM project after daemon restart. Topology and
    /// business repositories remain project-owned; this only enumerates the
    /// daemon control records.
    pub async fn list_all(&self) -> Result<Vec<ProjectState>> {
        let _guard = self.mutation.lock().await;
        let entries = match std::fs::read_dir(&self.root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error).context("reading PM project state directory"),
        };
        let mut paths = entries
            .collect::<std::io::Result<Vec<_>>>()?
            .into_iter()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("json"))
            .collect::<Vec<_>>();
        paths.sort();
        let mut projects = Vec::with_capacity(paths.len());
        for path in paths {
            match load_project_file(&path) {
                Ok(state) => projects.push(state),
                Err(error) => {
                    // One corrupted or unsafe record must not stop supervision
                    // for every other local project. The bad record remains on
                    // disk for diagnosis and manual recovery.
                    tracing::warn!(path = %path.display(), %error, "skipping invalid PM project state");
                }
            }
        }
        Ok(projects)
    }

    /// Record a cheap daemon observation. The first observation is normally a
    /// baseline; later status changes persist a pending PM wake. When the graph
    /// has actionable work but no running worker that can produce a new event,
    /// a due backoff check also persists a wake so an active project cannot
    /// strand itself between state-machine steps.
    pub async fn reconcile_supervisor(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        digest: String,
        active_work: bool,
        wake_when_quiet: bool,
        now_ms: i64,
    ) -> Result<SupervisorDecision> {
        if digest.trim().is_empty() || digest.len() > 512 {
            anyhow::bail!("supervisor observation digest must be 1-512 characters");
        }
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.lifecycle != ProjectLifecycle::Active {
            return Ok(SupervisorDecision {
                project: state,
                wake_manager: false,
            });
        }

        let mut changed_state = false;
        if active_work
            && (state.supervisor.mode != supervisor::SupervisorMode::Active
                || state.supervisor.observation_digest.is_none())
        {
            state.supervisor.baseline(digest, now_ms);
            changed_state = true;
        } else if active_work {
            let changed = state.supervisor.observation_digest.as_deref() != Some(&digest);
            let due = state.supervisor.due(now_ms);
            if changed || due {
                state.supervisor.observe(digest, true, false, false, now_ms);
                if !changed && due && wake_when_quiet {
                    state.supervisor.request_quiet_wake(now_ms);
                }
                changed_state = true;
            }
        } else if state.supervisor.mode != supervisor::SupervisorMode::Idle
            || state.supervisor.wake_pending
        {
            state
                .supervisor
                .observe(digest, false, false, false, now_ms);
            changed_state = true;
        }

        if changed_state {
            state.touch(now_ms);
            self.save(&state)?;
        }
        Ok(SupervisorDecision {
            wake_manager: state.supervisor.wake_ready(now_ms),
            project: state,
        })
    }

    /// Clear only the wake for the observation actually handed off. A newer
    /// event racing the PM turn remains pending.
    pub async fn acknowledge_supervisor_wake(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        expected_digest: &str,
    ) -> Result<()> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.supervisor.observation_digest.as_deref() == Some(expected_digest)
            && state.supervisor.wake_pending
        {
            state.supervisor.acknowledge_wake();
            state.touch(now_ms());
            self.save(&state)?;
        }
        Ok(())
    }

    /// Bind a persisted pending wake to the exact PM adapter turn that accepted
    /// it.  The wake remains pending until that turn is durably completed.
    pub async fn mark_supervisor_wake_dispatched(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        expected_digest: &str,
        turn_id: &str,
    ) -> Result<()> {
        if turn_id.trim().is_empty() || turn_id.len() > 200 {
            anyhow::bail!("supervisor wake turn id must be 1-200 characters");
        }
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.supervisor.observation_digest.as_deref() == Some(expected_digest)
            && state.supervisor.wake_pending
        {
            state.supervisor.mark_wake_dispatched(turn_id.to_string());
            state.touch(now_ms());
            self.save(&state)?;
        }
        Ok(())
    }

    /// Settle the exact PM turn recorded by `mark_supervisor_wake_dispatched`.
    /// A completed turn acknowledges the wake. A provider/model failure keeps
    /// the durable wake but applies bounded retry backoff; interruption,
    /// cancellation, a missing turn, or supersession remains immediately
    /// recoverable (most importantly across an in-place daemon reload).
    pub async fn settle_supervisor_wake_dispatch(
        &self,
        project_workspace_id: &str,
        controller_session_id: &str,
        expected_digest: &str,
        expected_turn_id: &str,
        outcome: WakeDispatchOutcome,
        now_ms: i64,
    ) -> Result<()> {
        let _guard = self.mutation.lock().await;
        let mut state = self.load(project_workspace_id)?;
        state.ensure_controller(controller_session_id)?;
        if state.supervisor.observation_digest.as_deref() == Some(expected_digest)
            && state.supervisor.wake_pending
            && state.supervisor.wake_turn_id.as_deref() == Some(expected_turn_id)
        {
            match outcome {
                WakeDispatchOutcome::Completed => state.supervisor.acknowledge_wake(),
                WakeDispatchOutcome::Failed => state.supervisor.defer_failed_wake_dispatch(now_ms),
                WakeDispatchOutcome::Interrupted => {
                    state.supervisor.release_interrupted_wake_dispatch()
                }
            }
            state.touch(now_ms);
            self.save(&state)?;
        }
        Ok(())
    }

    fn path(&self, project_workspace_id: &str) -> Result<PathBuf> {
        if project_workspace_id.is_empty()
            || project_workspace_id.len() > 200
            || !project_workspace_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            anyhow::bail!("invalid PM project workspace id");
        }
        Ok(self.root.join(format!("{project_workspace_id}.json")))
    }

    fn load_optional(&self, project_workspace_id: &str) -> Result<Option<ProjectState>> {
        let path = self.path(project_workspace_id)?;
        match std::fs::read_to_string(&path) {
            Ok(raw) => {
                let state: ProjectState = serde_json::from_str(&raw)
                    .with_context(|| format!("parsing PM project {}", path.display()))?;
                if state.format != PM_PROJECT_FORMAT {
                    anyhow::bail!(
                        "unsupported PM project format {} (supports {})",
                        state.format,
                        PM_PROJECT_FORMAT
                    );
                }
                Ok(Some(state))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }

    fn load(&self, project_workspace_id: &str) -> Result<ProjectState> {
        self.load_optional(project_workspace_id)?
            .ok_or_else(|| anyhow::anyhow!("this PM project is not initialized"))
    }

    fn save(&self, state: &ProjectState) -> Result<()> {
        let mut body = serde_json::to_string_pretty(state)?;
        body.push('\n');
        crate::config::save_private(&self.path(&state.project_workspace_id)?, body.as_bytes())
    }
}

pub(crate) async fn verify_recorded_agent_space(
    project: &ProjectState,
    space: &AgentSpaceRecord,
) -> Result<()> {
    let verified = crate::agent_space_builder::verify_space(&project.root, &space.source_path)
        .with_context(|| {
            format!(
                "recorded Agent Space {} no longer passes Builder verification",
                space.name
            )
        })?;
    if verified.name != space.name || verified.lock_digest != space.builder_lock_digest {
        anyhow::bail!(
            "recorded Agent Space {} changed; rebuild, commit, and record its new source commit and Builder lock before continuing",
            space.name
        );
    }
    crate::git::verify_clean_project_sources_at_commit(
        &project.root,
        &space.source_commit,
        &space.source_path,
    )
    .await
    .with_context(|| {
        format!(
            "recorded Agent Space {} no longer matches the clean project source commit",
            space.name
        )
    })?;
    Ok(())
}

fn load_project_file(path: &Path) -> Result<ProjectState> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        anyhow::bail!("unsafe PM project state entry: {}", path.display());
    }
    let state: ProjectState = serde_json::from_slice(&std::fs::read(path)?)
        .with_context(|| format!("parsing PM project {}", path.display()))?;
    if state.format != PM_PROJECT_FORMAT {
        anyhow::bail!(
            "unsupported PM project format {} (supports {})",
            state.format,
            PM_PROJECT_FORMAT
        );
    }
    Ok(state)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub project: ProjectState,
    pub wake_manager: bool,
}

#[derive(Debug, Clone)]
pub struct SupervisorDecision {
    pub project: ProjectState,
    pub wake_manager: bool,
}

fn preflight_empty_project(root: &Path) -> Result<()> {
    for entry in std::fs::read_dir(root)
        .with_context(|| format!("reading PM project root {}", root.display()))?
    {
        let entry = entry?;
        let name = entry.file_name();
        if name == ".genethub" {
            let metadata = std::fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                anyhow::bail!("the allowed .genethub entry must be a real directory");
            }
            continue;
        }
        anyhow::bail!(
            "new PM projects require an empty Folder workspace; found {}",
            entry.path().display()
        );
    }
    Ok(())
}

fn validate_phase_evidence(state: &ProjectState, phase: ProjectPhase) -> Result<()> {
    match phase {
        ProjectPhase::FolderSelected | ProjectPhase::PreflightPassed => {}
        ProjectPhase::GitReady => {
            if !state.root.join(".git").exists() {
                anyhow::bail!("gitReady requires the project Space-management Git repository");
            }
            for directory in ["spaces", "repositories", "worktrees"] {
                if !state.root.join(directory).is_dir() {
                    anyhow::bail!("gitReady requires the project {directory}/ directory");
                }
            }
        }
        ProjectPhase::TopologyVerified => {
            let spaces = state.root.join("spaces");
            let verified = std::fs::read_dir(&spaces)
                .into_iter()
                .flatten()
                .flatten()
                .map(|entry| entry.path())
                .any(|space| {
                    space.join("pipespace.json").is_file()
                        && space.join(".pipebuilder/lock.json").is_file()
                });
            if !verified {
                anyhow::bail!("topologyVerified requires at least one Builder-locked Agent Space");
            }
        }
        ProjectPhase::WorkspacesRegistered => {
            if state.agent_spaces.is_empty() {
                anyhow::bail!("workspacesRegistered requires at least one recorded Agent Space");
            }
        }
        ProjectPhase::Active => {
            if state.intent.is_none()
                || state.work_packages.is_empty()
                || state.agent_spaces.is_empty()
            {
                anyhow::bail!("active requires Intent, work packages, and registered Agent Spaces");
            }
        }
    }
    Ok(())
}

fn unique_values(label: &str, values: &[String]) -> Result<()> {
    let unique: BTreeSet<_> = values.iter().collect();
    if unique.len() != values.len() {
        anyhow::bail!("duplicate {label}");
    }
    Ok(())
}

fn has_running_work(state: &ProjectState) -> bool {
    state
        .work_packages
        .values()
        .any(|package| package.status == WorkPackageStatus::Running)
}

fn validate_kebab_name(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (byte == b'-' && index > 0 && index + 1 < value.len())
        })
    {
        anyhow::bail!("Agent Space name must be lowercase kebab-case");
    }
    Ok(())
}

fn validate_git_object(value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("source commit must be a full Git object id");
    }
    Ok(())
}

fn is_clean_descendant(path: &Path, root: &Path) -> bool {
    path.starts_with(root)
        && path != root
        && !path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn project_status(state: &ProjectState) -> Result<PmProjectStatus> {
    let work_packages = state
        .work_packages
        .values()
        .map(|package| {
            Ok(PmWorkPackageStatus {
                id: package.id.clone(),
                title: package.title.clone(),
                outcome: package.outcome.clone(),
                status: enum_wire_name(package.status)?,
                dependencies: package.dependencies.clone(),
                agent_space: package.agent_space.clone(),
                branch: package.branch.clone(),
                work_session_id: package.work_session_id.clone(),
                candidate_commit: package.candidate.as_ref().map(|item| item.commit.clone()),
                candidate_tree: package.candidate.as_ref().map(|item| item.tree.clone()),
                review_session_id: package.review.as_ref().map(|item| item.session_id.clone()),
                review_verdict: package
                    .review
                    .as_ref()
                    .and_then(|item| item.verdict)
                    .map(enum_wire_name)
                    .transpose()?,
                block_reason: package.block_reason.clone(),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    let agent_spaces = state
        .agent_spaces
        .values()
        .map(|space| {
            Ok(PmAgentSpaceStatus {
                name: space.name.clone(),
                purpose: space.purpose.clone(),
                workspace_id: space.workspace_id.clone(),
                source_commit: space.source_commit.clone(),
                builder_lock_digest: space.builder_lock_digest.clone(),
                role: enum_wire_name(space.role)?,
                active: space.active,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(PmProjectStatus {
        workspace_id: state.project_workspace_id.clone(),
        controller_session_id: state.controller_session_id.clone(),
        phase: enum_wire_name(state.phase)?,
        lifecycle: enum_wire_name(state.lifecycle)?,
        revision: state.revision,
        intent: state.intent.as_ref().map(|intent| PmIntentStatus {
            revision: intent.revision,
            outcome: intent.outcome.clone(),
            acceptance: intent.acceptance.clone(),
            constraints: intent.constraints.clone(),
            out_of_scope: intent.out_of_scope.clone(),
        }),
        work_packages,
        agent_spaces,
        supervisor: PmSupervisorStatus {
            mode: enum_wire_name(state.supervisor.mode)?,
            next_check_at_ms: state.supervisor.next_check_at_ms,
            wake_pending: state.supervisor.wake_pending,
        },
        updated_at_ms: state.updated_at_ms,
    })
}

fn enum_wire_name(value: impl Serialize) -> Result<String> {
    serde_json::to_value(value)?
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow::anyhow!("PM enum did not serialize as a wire string"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use task_graph::{ReviewVerdict, WorkPackageStatus};

    async fn test_git(root: &Path, args: &[&str]) -> String {
        let output = tokio::process::Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .await
            .unwrap();
        assert!(
            output.status.success(),
            "git {} failed: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap()
    }

    fn project_root(temp: &tempfile::TempDir) -> PathBuf {
        let root = temp.path().join("project");
        std::fs::create_dir_all(root.join(".genethub/sessions")).unwrap();
        root
    }

    #[tokio::test]
    async fn initialization_is_empty_folder_only_and_idempotent_for_its_controller() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let store = ProjectStore::new(&temp.path().join("data"));
        let first = store.initialize("w_1", "s_pm", &root).await.unwrap();
        assert_eq!(first.phase, ProjectPhase::PreflightPassed);
        assert_eq!(store.initialize("w_1", "s_pm", &root).await.unwrap(), first);
        assert!(store.initialize("w_1", "s_other", &root).await.is_err());

        let other = temp.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("unknown.txt"), "mine").unwrap();
        assert!(store.initialize("w_2", "s_pm2", &other).await.is_err());
    }

    #[tokio::test]
    async fn supervisor_backoff_and_pending_wake_survive_daemon_restart() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let data = temp.path().join("data");
        let store = ProjectStore::new(&data);
        store.initialize("w_1", "s_pm", &root).await.unwrap();

        let baseline = store
            .reconcile_supervisor("w_1", "s_pm", "running".into(), true, false, 1_000)
            .await
            .unwrap();
        assert!(!baseline.wake_manager);
        assert_eq!(baseline.project.supervisor.next_check_at_ms, Some(31_000));

        drop(store);
        let recovered = ProjectStore::new(&data);
        let quiet = recovered
            .reconcile_supervisor("w_1", "s_pm", "running".into(), true, false, 31_000)
            .await
            .unwrap();
        assert!(!quiet.wake_manager);
        assert_eq!(quiet.project.supervisor.backoff_step, 1);
        assert_eq!(quiet.project.supervisor.next_check_at_ms, Some(91_000));

        let changed = recovered
            .reconcile_supervisor("w_1", "s_pm", "idle".into(), true, false, 32_000)
            .await
            .unwrap();
        assert!(changed.wake_manager);
        assert_eq!(changed.project.supervisor.next_check_at_ms, Some(62_000));

        drop(recovered);
        let restarted = ProjectStore::new(&data);
        let persisted = restarted.get("w_1", "s_pm").await.unwrap();
        assert!(persisted.supervisor.wake_pending);
        restarted
            .mark_supervisor_wake_dispatched("w_1", "s_pm", "idle", "turn-interrupted")
            .await
            .unwrap();
        drop(restarted);

        let after_reload = ProjectStore::new(&data);
        let persisted = after_reload.get("w_1", "s_pm").await.unwrap();
        assert!(
            persisted.supervisor.wake_pending,
            "dispatch is not an acknowledgement"
        );
        assert_eq!(
            persisted.supervisor.wake_turn_id.as_deref(),
            Some("turn-interrupted")
        );
        after_reload
            .settle_supervisor_wake_dispatch(
                "w_1",
                "s_pm",
                "idle",
                "turn-interrupted",
                WakeDispatchOutcome::Interrupted,
                32_001,
            )
            .await
            .unwrap();
        let retry = after_reload.get("w_1", "s_pm").await.unwrap();
        assert!(retry.supervisor.wake_pending);
        assert!(retry.supervisor.wake_turn_id.is_none());

        after_reload
            .mark_supervisor_wake_dispatched("w_1", "s_pm", "idle", "turn-completed")
            .await
            .unwrap();
        after_reload
            .settle_supervisor_wake_dispatch(
                "w_1",
                "s_pm",
                "idle",
                "turn-completed",
                WakeDispatchOutcome::Completed,
                32_002,
            )
            .await
            .unwrap();
        assert!(
            !after_reload
                .get("w_1", "s_pm")
                .await
                .unwrap()
                .supervisor
                .wake_pending
        );

        let changed_again = after_reload
            .reconcile_supervisor("w_1", "s_pm", "new-idle".into(), true, false, 33_000)
            .await
            .unwrap();
        assert!(changed_again.wake_manager);
        after_reload
            .acknowledge_supervisor_wake("w_1", "s_pm", "stale")
            .await
            .unwrap();
        assert!(
            after_reload
                .get("w_1", "s_pm")
                .await
                .unwrap()
                .supervisor
                .wake_pending
        );
        after_reload
            .acknowledge_supervisor_wake("w_1", "s_pm", "new-idle")
            .await
            .unwrap();
        assert!(
            !after_reload
                .get("w_1", "s_pm")
                .await
                .unwrap()
                .supervisor
                .wake_pending
        );
    }

    #[tokio::test]
    async fn supervisor_does_not_compete_with_user_guidance_on_an_empty_or_new_graph() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let store = ProjectStore::new(&temp.path().join("data"));
        store.initialize("w_1", "s_pm", &root).await.unwrap();

        let empty = store
            .reconcile_supervisor("w_1", "s_pm", "empty".into(), false, true, 1_000)
            .await
            .unwrap();
        assert_eq!(
            empty.project.supervisor.mode,
            supervisor::SupervisorMode::Idle
        );
        assert!(!empty.project.supervisor.wake_pending);
        assert!(empty.project.supervisor.next_check_at_ms.is_none());

        let new_graph = store
            .reconcile_supervisor("w_1", "s_pm", "ready".into(), true, true, 2_000)
            .await
            .unwrap();
        assert!(!new_graph.wake_manager);
        assert!(!new_graph.project.supervisor.wake_pending);
        assert_eq!(new_graph.project.supervisor.next_check_at_ms, Some(32_000));

        let due = store
            .reconcile_supervisor("w_1", "s_pm", "ready".into(), true, true, 32_000)
            .await
            .unwrap();
        assert!(due.wake_manager);
        assert!(due.project.supervisor.wake_pending);
    }

    #[tokio::test]
    async fn quiet_actionable_project_requests_a_bounded_wake() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let store = ProjectStore::new(&temp.path().join("data"));
        store.initialize("w_1", "s_pm", &root).await.unwrap();
        let baseline = store
            .reconcile_supervisor("w_1", "s_pm", "quiet".into(), true, false, 1_000)
            .await
            .unwrap();
        assert!(!baseline.wake_manager);

        let due = store
            .reconcile_supervisor("w_1", "s_pm", "quiet".into(), true, true, 31_000)
            .await
            .unwrap();
        assert!(due.wake_manager);
        assert!(due.project.supervisor.wake_turn_id.is_none());
    }

    #[tokio::test]
    async fn failed_supervisor_wakes_use_bounded_provider_backoff() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let store = ProjectStore::new(&temp.path().join("data"));
        store.initialize("w_1", "s_pm", &root).await.unwrap();
        store
            .reconcile_supervisor("w_1", "s_pm", "running".into(), true, false, 1_000)
            .await
            .unwrap();
        assert!(
            store
                .reconcile_supervisor("w_1", "s_pm", "changed".into(), true, false, 2_000)
                .await
                .unwrap()
                .wake_manager
        );

        let delays = [30_000, 60_000, 120_000, 300_000, 300_000];
        let mut failed_at = 3_000;
        for (index, delay) in delays.into_iter().enumerate() {
            let turn_id = format!("turn-failed-{index}");
            store
                .mark_supervisor_wake_dispatched("w_1", "s_pm", "changed", &turn_id)
                .await
                .unwrap();
            store
                .settle_supervisor_wake_dispatch(
                    "w_1",
                    "s_pm",
                    "changed",
                    &turn_id,
                    WakeDispatchOutcome::Failed,
                    failed_at,
                )
                .await
                .unwrap();

            let retry_at = failed_at + delay;
            let deferred = store
                .reconcile_supervisor("w_1", "s_pm", "changed".into(), true, true, retry_at - 1)
                .await
                .unwrap();
            assert!(!deferred.wake_manager);
            assert_eq!(deferred.project.supervisor.wake_retry_at_ms, Some(retry_at));

            let ready = store
                .reconcile_supervisor("w_1", "s_pm", "changed".into(), true, true, retry_at)
                .await
                .unwrap();
            assert!(ready.wake_manager);
            failed_at = retry_at;
        }

        store
            .mark_supervisor_wake_dispatched("w_1", "s_pm", "changed", "turn-completed")
            .await
            .unwrap();
        store
            .settle_supervisor_wake_dispatch(
                "w_1",
                "s_pm",
                "changed",
                "turn-completed",
                WakeDispatchOutcome::Completed,
                failed_at,
            )
            .await
            .unwrap();
        let completed = store.get("w_1", "s_pm").await.unwrap();
        assert!(!completed.supervisor.wake_pending);
        assert_eq!(completed.supervisor.wake_retry_step, 0);
        assert!(completed.supervisor.wake_retry_at_ms.is_none());
    }

    #[tokio::test]
    async fn one_corrupt_project_record_does_not_hide_other_projects() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path().join("data");
        let store = ProjectStore::new(&data);
        for (workspace, session) in [("w_a", "s_a"), ("w_b", "s_b")] {
            let root = temp.path().join(workspace);
            std::fs::create_dir_all(root.join(".genethub")).unwrap();
            store.initialize(workspace, session, &root).await.unwrap();
        }
        std::fs::write(data.join("pm-projects/bad.json"), "not json\n").unwrap();

        let projects = store.list_all().await.unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0].project_workspace_id, "w_a");
        assert_eq!(projects[1].project_workspace_id, "w_b");
    }

    #[tokio::test]
    async fn completed_delivery_can_reopen_for_new_user_scope_but_cancelled_cannot() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let store = ProjectStore::new(&temp.path().join("data"));
        let mut project = store.initialize("w_project", "s_pm", &root).await.unwrap();
        project.phase = ProjectPhase::Active;
        let mut package = WorkPackage::planned(
            "demo".into(),
            "Demo".into(),
            "Accepted demo".into(),
            vec![],
            "implementation".into(),
            "work/demo".into(),
            root.join("worktrees/implementation/game"),
            1,
        )
        .unwrap();
        package.status = WorkPackageStatus::Accepted;
        project.work_packages.insert(package.id.clone(), package);
        store.save(&project).unwrap();

        store
            .set_lifecycle("w_project", "s_pm", ProjectLifecycle::Completed)
            .await
            .unwrap();
        let reopened = store
            .set_lifecycle("w_project", "s_pm", ProjectLifecycle::Active)
            .await
            .unwrap();
        assert_eq!(reopened.lifecycle, ProjectLifecycle::Active);
        assert_eq!(
            reopened.work_packages["demo"].status,
            WorkPackageStatus::Accepted
        );

        store
            .set_lifecycle("w_project", "s_pm", ProjectLifecycle::Cancelled)
            .await
            .unwrap();
        assert!(store
            .set_lifecycle("w_project", "s_pm", ProjectLifecycle::Active)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn work_session_dispatch_is_dag_bound_to_worktree_and_separate_review_space() {
        let temp = tempfile::tempdir().unwrap();
        let root = project_root(&temp);
        let data = temp.path().join("data");
        let store = ProjectStore::new(&data);
        let mut project = store.initialize("w_project", "s_pm", &root).await.unwrap();

        let worktree = root.join("worktrees/implementation/game");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(root.join("spaces")).unwrap();
        project.phase = ProjectPhase::Active;
        let mut spaces = Vec::new();
        for (name, workspace_id) in [
            ("implementation", "w_implementation"),
            ("review", "w_review"),
        ] {
            let source_path = root.join("spaces").join(name);
            crate::agent_space_builder::run(
                &root,
                &source_path,
                crate::agent_space_builder::Command::Init,
                true,
            )
            .unwrap();
            crate::agent_space_builder::run(
                &root,
                &source_path,
                crate::agent_space_builder::Command::Build { dry_run: false },
                true,
            )
            .unwrap();
            let verified = crate::agent_space_builder::verify_space(&root, &source_path).unwrap();
            spaces.push((name, workspace_id, source_path, verified.lock_digest));
        }
        std::fs::write(
            root.join(".gitignore"),
            ".genethub/\nrepositories/\nworktrees/\n",
        )
        .unwrap();
        test_git(&root, &["init", "-q"]).await;
        test_git(&root, &["config", "user.email", "test@example.com"]).await;
        test_git(&root, &["config", "user.name", "Test"]).await;
        test_git(&root, &["config", "commit.gpgsign", "false"]).await;
        test_git(&root, &["add", "-A"]).await;
        test_git(&root, &["commit", "-qm", "Record Agent Spaces"]).await;
        let source_commit = test_git(&root, &["rev-parse", "HEAD"])
            .await
            .trim()
            .to_string();
        for (name, workspace_id, source_path, builder_lock_digest) in spaces {
            project.agent_spaces.insert(
                name.into(),
                AgentSpaceRecord {
                    name: name.into(),
                    purpose: name.into(),
                    source_path,
                    workspace_id: workspace_id.into(),
                    source_commit: source_commit.clone(),
                    builder_lock_digest,
                    role: if name == "review" {
                        AgentSpaceRole::Review
                    } else {
                        AgentSpaceRole::Implementation
                    },
                    active: true,
                    updated_at_ms: 1,
                },
            );
        }
        let mut package = WorkPackage::planned(
            "gameplay".into(),
            "Gameplay".into(),
            "Playable slice".into(),
            vec![],
            "implementation".into(),
            "work/gameplay".into(),
            worktree.canonicalize().unwrap(),
            1,
        )
        .unwrap();
        package.status = WorkPackageStatus::Ready;
        project.work_packages.insert(package.id.clone(), package);
        store.save(&project).unwrap();

        let implementation = store
            .authorize_work_session("w_project", "s_pm", "w_implementation", "gameplay")
            .await
            .unwrap();
        assert_eq!(implementation.kind, WorkDispatchKind::Implementation);
        assert_eq!(implementation.cwd, worktree.canonicalize().unwrap());
        let manifest_path = root.join("spaces/implementation/pipespace.json");
        let manifest = std::fs::read(&manifest_path).unwrap();
        std::fs::write(&manifest_path, [manifest.as_slice(), b"\n"].concat()).unwrap();
        assert!(store
            .authorize_work_session("w_project", "s_pm", "w_implementation", "gameplay")
            .await
            .is_err());
        std::fs::write(&manifest_path, manifest).unwrap();
        assert!(store
            .authorize_work_session("w_project", "s_pm", "w_review", "gameplay")
            .await
            .is_err());

        let mut candidate = store.get("w_project", "s_pm").await.unwrap();
        candidate.work_packages.get_mut("gameplay").unwrap().status = WorkPackageStatus::Candidate;
        store.save(&candidate).unwrap();
        assert!(store
            .authorize_work_session("w_project", "s_pm", "w_implementation", "gameplay",)
            .await
            .is_err());
        let review = store
            .authorize_work_session("w_project", "s_pm", "w_review", "gameplay")
            .await
            .unwrap();
        assert_eq!(review.kind, WorkDispatchKind::Review);
        assert_eq!(review.cwd, worktree.canonicalize().unwrap());
    }

    #[test]
    fn graph_rejects_shared_worktrees_and_accepts_only_exact_passing_reviews() {
        let root = PathBuf::from("/project/worktrees/code/repo");
        let first = WorkPackage::planned(
            "a".into(),
            "A".into(),
            "Implement A".into(),
            vec![],
            "code".into(),
            "work/a".into(),
            root.clone(),
            1,
        )
        .unwrap();
        let second = WorkPackage::planned(
            "b".into(),
            "B".into(),
            "Implement B".into(),
            vec![],
            "code-2".into(),
            "work/b".into(),
            root,
            1,
        )
        .unwrap();
        let mut graph = [(first.id.clone(), first), (second.id.clone(), second)]
            .into_iter()
            .collect();
        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Ready,
            None,
            None,
            None,
            None,
            2,
        )
        .unwrap();
        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Running,
            Some("s_work_a".into()),
            None,
            None,
            None,
            3,
        )
        .unwrap();
        task_graph::transition(
            &mut graph,
            "b",
            WorkPackageStatus::Ready,
            None,
            None,
            None,
            None,
            4,
        )
        .unwrap();
        assert!(task_graph::transition(
            &mut graph,
            "b",
            WorkPackageStatus::Running,
            Some("s_work_b".into()),
            None,
            None,
            None,
            5,
        )
        .is_err());

        let commit = "a".repeat(40);
        let tree = "b".repeat(40);
        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Candidate,
            None,
            Some(CandidateEvidence {
                repository: "game".into(),
                commit: commit.clone(),
                tree: tree.clone(),
                evidence: vec!["cargo test: passed".into()],
            }),
            None,
            None,
            6,
        )
        .unwrap();
        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Review,
            None,
            None,
            Some(ReviewEvidence {
                session_id: "s_review_a".into(),
                candidate_commit: commit.clone(),
                candidate_tree: tree.clone(),
                verdict: None,
                evidence: vec!["review started".into()],
            }),
            None,
            7,
        )
        .unwrap();
        assert!(task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Accepted,
            None,
            None,
            None,
            None,
            8,
        )
        .is_err());
        assert!(task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Accepted,
            None,
            None,
            Some(ReviewEvidence {
                session_id: "s_review_a".into(),
                candidate_commit: "c".repeat(40),
                candidate_tree: tree.clone(),
                verdict: Some(ReviewVerdict::Pass),
                evidence: vec!["review passed".into()],
            }),
            None,
            9,
        )
        .is_err());
        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Accepted,
            None,
            None,
            Some(ReviewEvidence {
                session_id: "s_review_a".into(),
                candidate_commit: commit,
                candidate_tree: tree,
                verdict: Some(ReviewVerdict::Pass),
                evidence: vec!["review passed".into()],
            }),
            None,
            10,
        )
        .unwrap();
        assert_eq!(graph["a"].status, WorkPackageStatus::Accepted);
    }

    #[test]
    fn idempotent_transition_cannot_rebind_a_session_or_candidate() {
        let mut package = WorkPackage::planned(
            "a".into(),
            "A".into(),
            "Implement A".into(),
            vec![],
            "code".into(),
            "work/a".into(),
            PathBuf::from("/project/worktrees/code/repo"),
            1,
        )
        .unwrap();
        package.status = WorkPackageStatus::Running;
        package.work_session_id = Some("s_original".into());
        let mut graph = [(package.id.clone(), package)].into_iter().collect();
        assert!(task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Running,
            Some("s_rebound".into()),
            None,
            None,
            None,
            2,
        )
        .is_err());
    }

    #[test]
    fn review_rework_returns_to_a_clean_dispatchable_attempt() {
        let mut package = WorkPackage::planned(
            "a".into(),
            "A".into(),
            "Implement A".into(),
            vec![],
            "code".into(),
            "work/a".into(),
            PathBuf::from("/project/worktrees/code/repo"),
            1,
        )
        .unwrap();
        package.status = WorkPackageStatus::Review;
        package.work_session_id = Some("s_implementation".into());
        package.candidate = Some(CandidateEvidence {
            repository: "game".into(),
            commit: "a".repeat(40),
            tree: "b".repeat(40),
            evidence: vec!["tests passed".into()],
        });
        package.review = Some(ReviewEvidence {
            session_id: "s_review".into(),
            candidate_commit: "a".repeat(40),
            candidate_tree: "b".repeat(40),
            verdict: Some(ReviewVerdict::Fail),
            evidence: vec!["rework required".into()],
        });
        let mut graph = [(package.id.clone(), package)].into_iter().collect();

        task_graph::transition(
            &mut graph,
            "a",
            WorkPackageStatus::Ready,
            None,
            None,
            None,
            None,
            2,
        )
        .unwrap();

        assert_eq!(graph["a"].status, WorkPackageStatus::Ready);
        assert!(graph["a"].work_session_id.is_none());
        assert!(graph["a"].candidate.is_none());
        assert!(graph["a"].review.is_none());
    }

    #[test]
    fn supervisor_is_event_first_and_stops_polling_for_people_or_terminal_work() {
        let mut supervisor = supervisor::SupervisorState::idle();
        assert!(supervisor.observe("one".into(), true, false, false, 1_000));
        assert_eq!(supervisor.next_check_at_ms, Some(31_000));
        assert!(!supervisor.observe("one".into(), true, false, false, 31_000));
        assert_eq!(supervisor.next_check_at_ms, Some(91_000));
        supervisor.observe("waiting".into(), true, true, false, 40_000);
        assert_eq!(supervisor.next_check_at_ms, None);
        supervisor.observe("done".into(), false, false, true, 50_000);
        assert_eq!(supervisor.next_check_at_ms, None);
    }
}
