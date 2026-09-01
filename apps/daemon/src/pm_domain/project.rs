use std::collections::BTreeMap;
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use super::dcg::DcgRun;
use super::supervisor::SupervisorState;
use super::task_graph::WorkPackage;
use super::topology::AgentSpaceRecord;

pub const PM_PROJECT_FORMAT: u32 = 7;

/// WorkPackage ids are local to one PM Session. Persisted map keys include the
/// owner length so two Sessions may independently use names such as `ui`
/// without ambiguity or delimiter collisions.
pub fn work_package_storage_key(controller_session_id: &str, package_id: &str) -> String {
    format!(
        "{}:{controller_session_id}:{package_id}",
        controller_session_id.len()
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectPhase {
    FolderSelected,
    PreflightPassed,
    GitReady,
    TopologyVerified,
    WorkspacesRegistered,
    Active,
}

impl ProjectPhase {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "folder-selected" | "folderSelected" => Some(Self::FolderSelected),
            "preflight-passed" | "preflightPassed" => Some(Self::PreflightPassed),
            "git-ready" | "gitReady" => Some(Self::GitReady),
            "topology-verified" | "topologyVerified" => Some(Self::TopologyVerified),
            "workspaces-registered" | "workspacesRegistered" => Some(Self::WorkspacesRegistered),
            "active" => Some(Self::Active),
            _ => None,
        }
    }

    pub fn next(self) -> Option<Self> {
        match self {
            Self::FolderSelected => Some(Self::PreflightPassed),
            Self::PreflightPassed => Some(Self::GitReady),
            Self::GitReady => Some(Self::TopologyVerified),
            Self::TopologyVerified => Some(Self::WorkspacesRegistered),
            Self::WorkspacesRegistered => Some(Self::Active),
            Self::Active => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectLifecycle {
    Active,
    WaitingUser,
    Completed,
    Cancelled,
}

impl ProjectLifecycle {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(Self::Active),
            "waiting-user" | "waitingUser" => Some(Self::WaitingUser),
            "completed" => Some(Self::Completed),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentRevision {
    pub revision: u64,
    pub outcome: String,
    pub acceptance: Vec<String>,
    pub constraints: Vec<String>,
    pub out_of_scope: Vec<String>,
    pub affected_work_packages: Vec<String>,
    pub recorded_at_ms: i64,
}

impl IntentRevision {
    pub fn validate(&self) -> Result<()> {
        if self.outcome.trim().is_empty() || self.outcome.len() > 8_000 {
            anyhow::bail!("intent outcome must be 1-8000 characters");
        }
        validate_items("acceptance", &self.acceptance, true)?;
        validate_items("constraints", &self.constraints, false)?;
        validate_items("outOfScope", &self.out_of_scope, false)?;
        Ok(())
    }
}

fn validate_items(name: &str, values: &[String], nonempty: bool) -> Result<()> {
    if nonempty && values.is_empty() {
        anyhow::bail!("intent {name} must contain at least one item");
    }
    if values.len() > 128 {
        anyhow::bail!("intent {name} contains too many items");
    }
    if values
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 2_000)
    {
        anyhow::bail!("intent {name} items must be 1-2000 characters");
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectState {
    pub format: u32,
    pub project_id: String,
    pub project_workspace_id: String,
    /// Session that bootstrapped the shared project. This is historical
    /// provenance only; every authorized manager, including this one, must
    /// own an exact entry in `session_dcg_runs`.
    #[serde(alias = "controllerSessionId")]
    pub bootstrap_session_id: String,
    /// The manager AgentSpace shared by all PM Sessions for this project.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pm_space_workspace_id: Option<String>,
    /// Session-level DCG Runs keyed by their controller PM Session id.
    #[serde(default)]
    pub session_dcg_runs: BTreeMap<String, DcgRun>,
    pub root: PathBuf,
    pub phase: ProjectPhase,
    pub lifecycle: ProjectLifecycle,
    pub revision: u64,
    /// Read-only migration input for pre-v7 records. New records serialize
    /// only `sessionIntents`; there is no mutable project-wide primary Intent.
    #[serde(default, rename = "intent", skip_serializing)]
    pub legacy_intent: Option<IntentRevision>,
    /// Session-scoped intent prevents two concurrent PM conversations from
    /// invalidating or presenting each other's requirement revision.
    #[serde(default)]
    pub session_intents: BTreeMap<String, IntentRevision>,
    pub work_packages: BTreeMap<String, WorkPackage>,
    pub agent_spaces: BTreeMap<String, AgentSpaceRecord>,
    /// PM-proposed Workflow/Prompt changes. Candidates are inert until an
    /// independent review and an explicit user approval both bind the digest.
    #[serde(default)]
    pub improvement_candidates: BTreeMap<String, ImprovementCandidate>,
    /// Read-only migration input for pre-v7 records. New records serialize
    /// one Supervisor per Workflow Run only.
    #[serde(default, rename = "supervisor", skip_serializing)]
    pub legacy_supervisor: Option<SupervisorState>,
    /// One durable supervisor per PM Workflow Run.
    #[serde(default)]
    pub session_supervisors: BTreeMap<String, SupervisorState>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}

impl ProjectState {
    pub fn new(
        project_workspace_id: String,
        controller_session_id: String,
        root: PathBuf,
        now_ms: i64,
    ) -> Self {
        let primary_supervisor = SupervisorState::idle();
        let session_supervisors =
            BTreeMap::from([(controller_session_id.clone(), primary_supervisor.clone())]);
        Self {
            format: PM_PROJECT_FORMAT,
            project_id: project_workspace_id.clone(),
            project_workspace_id,
            bootstrap_session_id: controller_session_id,
            pm_space_workspace_id: None,
            session_dcg_runs: BTreeMap::new(),
            root,
            phase: ProjectPhase::PreflightPassed,
            lifecycle: ProjectLifecycle::Active,
            revision: 1,
            legacy_intent: None,
            session_intents: BTreeMap::new(),
            work_packages: BTreeMap::new(),
            agent_spaces: BTreeMap::new(),
            improvement_candidates: BTreeMap::new(),
            legacy_supervisor: None,
            session_supervisors,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        }
    }

    pub fn ensure_controller(&self, controller_session_id: &str) -> Result<()> {
        if !self.session_dcg_runs.contains_key(controller_session_id) {
            anyhow::bail!(
                "当前 PM Session 尚未附加到此项目；请通过受认证的 PM Session 创建/恢复入口建立独立 Workflow Run"
            );
        }
        Ok(())
    }

    pub fn ensure_package_owner(
        &self,
        controller_session_id: &str,
        package_id: &str,
    ) -> Result<()> {
        self.work_package(controller_session_id, package_id)
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "当前 PM Session 中不存在工作包 {package_id}；工作包 ID 仅在各自 Session 内有效，请先运行 `pm project status` 核对本 Session 的工作包"
                )
            })?;
        Ok(())
    }

    pub fn work_package(
        &self,
        controller_session_id: &str,
        package_id: &str,
    ) -> Option<&WorkPackage> {
        self.work_packages
            .get(&work_package_storage_key(controller_session_id, package_id))
    }

    pub fn work_package_mut(
        &mut self,
        controller_session_id: &str,
        package_id: &str,
    ) -> Option<&mut WorkPackage> {
        self.work_packages
            .get_mut(&work_package_storage_key(controller_session_id, package_id))
    }

    pub fn ensure_mutable(&self) -> Result<()> {
        if matches!(
            self.lifecycle,
            ProjectLifecycle::Completed | ProjectLifecycle::Cancelled
        ) {
            anyhow::bail!("a terminal PM project is retained and cannot be mutated");
        }
        Ok(())
    }

    pub fn advance(&mut self, phase: ProjectPhase, now_ms: i64) -> Result<()> {
        if self.phase == phase {
            return Ok(());
        }
        if self.phase.next() != Some(phase) {
            anyhow::bail!(
                "PM project phase must advance one verified stage at a time: {:?} -> {:?}",
                self.phase,
                phase
            );
        }
        self.phase = phase;
        self.touch(now_ms);
        Ok(())
    }

    pub fn touch(&mut self, now_ms: i64) {
        self.revision = self.revision.saturating_add(1);
        self.updated_at_ms = now_ms;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ImprovementCandidateStatus {
    Proposed,
    Reviewed,
    Approved,
    Promoted,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImprovementCandidate {
    pub id: String,
    pub target: String,
    pub source: PathBuf,
    pub base_digest: String,
    pub candidate_digest: String,
    pub rationale: String,
    pub status: ImprovementCandidateStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub review_evidence: Option<String>,
    #[serde(default)]
    pub user_approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub promoted_commit: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
}
