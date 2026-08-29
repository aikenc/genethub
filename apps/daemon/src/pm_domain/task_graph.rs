use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use anyhow::Result;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkPackageStatus {
    Planned,
    Ready,
    Running,
    Waiting,
    Candidate,
    Review,
    Accepted,
    Blocked,
    Cancelled,
}

impl WorkPackageStatus {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "planned" => Some(Self::Planned),
            "ready" => Some(Self::Ready),
            "running" => Some(Self::Running),
            "waiting" => Some(Self::Waiting),
            "candidate" => Some(Self::Candidate),
            "review" => Some(Self::Review),
            "accepted" => Some(Self::Accepted),
            "blocked" => Some(Self::Blocked),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateEvidence {
    pub repository: String,
    pub commit: String,
    pub tree: String,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReviewVerdict {
    Pass,
    Fail,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewEvidence {
    pub session_id: String,
    pub candidate_commit: String,
    pub candidate_tree: String,
    pub verdict: Option<ReviewVerdict>,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkPackage {
    pub id: String,
    pub title: String,
    pub outcome: String,
    pub dependencies: Vec<String>,
    pub agent_space: String,
    pub branch: String,
    pub worktree: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_instance_id: Option<String>,
    pub status: WorkPackageStatus,
    pub work_session_id: Option<String>,
    pub candidate: Option<CandidateEvidence>,
    pub review: Option<ReviewEvidence>,
    pub block_reason: Option<String>,
    pub updated_at_ms: i64,
}

impl WorkPackage {
    #[allow(clippy::too_many_arguments)]
    pub fn planned(
        id: String,
        title: String,
        outcome: String,
        dependencies: Vec<String>,
        agent_space: String,
        branch: String,
        worktree: PathBuf,
        now_ms: i64,
    ) -> Result<Self> {
        validate_identifier("work package id", &id, 160)?;
        validate_text("work package title", &title, 500)?;
        validate_text("work package outcome", &outcome, 4_000)?;
        validate_identifier("Agent Space name", &agent_space, 80)?;
        validate_text("branch", &branch, 500)?;
        if !worktree.is_absolute() {
            anyhow::bail!("work package worktree must be absolute");
        }
        let unique: BTreeSet<_> = dependencies.iter().collect();
        if unique.len() != dependencies.len() || dependencies.iter().any(|item| item == &id) {
            anyhow::bail!("work package dependencies must be unique and cannot include itself");
        }
        Ok(Self {
            id,
            title,
            outcome,
            dependencies,
            agent_space,
            branch,
            worktree,
            workflow_run_id: None,
            node_instance_id: None,
            status: WorkPackageStatus::Planned,
            work_session_id: None,
            candidate: None,
            review: None,
            block_reason: None,
            updated_at_ms: now_ms,
        })
    }

    pub fn bind_to_workflow(&mut self, run_id: String, node_instance_id: String) -> Result<()> {
        validate_identifier("workflow Run id", &run_id, 160)?;
        validate_identifier("workflow node instance id", &node_instance_id, 200)?;
        self.workflow_run_id = Some(run_id);
        self.node_instance_id = Some(node_instance_id);
        Ok(())
    }
}

fn validate_identifier(label: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max || value.chars().any(char::is_control) {
        anyhow::bail!("{label} must be 1-{max} printable characters");
    }
    Ok(())
}

fn validate_text(label: &str, value: &str, max: usize) -> Result<()> {
    if value.trim().is_empty() || value.len() > max {
        anyhow::bail!("{label} must be 1-{max} characters");
    }
    Ok(())
}

pub fn validate_graph(packages: &BTreeMap<String, WorkPackage>) -> Result<()> {
    for package in packages.values() {
        for dependency in &package.dependencies {
            if !packages.contains_key(dependency) {
                anyhow::bail!(
                    "work package {} depends on unknown package {dependency}",
                    package.id
                );
            }
        }
    }
    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    for id in packages.keys() {
        visit(id, packages, &mut visiting, &mut visited)?;
    }
    Ok(())
}

fn visit(
    id: &str,
    packages: &BTreeMap<String, WorkPackage>,
    visiting: &mut BTreeSet<String>,
    visited: &mut BTreeSet<String>,
) -> Result<()> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id.to_string()) {
        anyhow::bail!("work package dependency cycle includes {id}");
    }
    for dependency in &packages[id].dependencies {
        visit(dependency, packages, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id.to_string());
    Ok(())
}

pub fn transition(
    packages: &mut BTreeMap<String, WorkPackage>,
    id: &str,
    to: WorkPackageStatus,
    work_session_id: Option<String>,
    candidate: Option<CandidateEvidence>,
    review: Option<ReviewEvidence>,
    block_reason: Option<String>,
    now_ms: i64,
) -> Result<()> {
    let current = packages
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("no such work package: {id}"))?
        .clone();
    if current.status == to {
        if let Some(session) = work_session_id.as_deref() {
            if current.work_session_id.as_deref() != Some(session) {
                anyhow::bail!("idempotent running transition named another WorkSession");
            }
        }
        if let Some(candidate) = candidate.as_ref() {
            if current.candidate.as_ref() != Some(candidate) {
                anyhow::bail!("idempotent candidate transition changed immutable evidence");
            }
        }
        if let Some(review) = review.as_ref() {
            if current.review.as_ref() != Some(review) {
                anyhow::bail!("idempotent review transition changed bound evidence");
            }
        }
        if to == WorkPackageStatus::Blocked
            && block_reason.as_deref() != current.block_reason.as_deref()
        {
            anyhow::bail!("idempotent blocked transition changed its reason");
        }
        return Ok(());
    }
    if !allowed(current.status, to) {
        anyhow::bail!(
            "invalid work package transition: {:?} -> {:?}",
            current.status,
            to
        );
    }
    if matches!(to, WorkPackageStatus::Ready | WorkPackageStatus::Running)
        && current.dependencies.iter().any(|dependency| {
            packages
                .get(dependency)
                .is_none_or(|package| package.status != WorkPackageStatus::Accepted)
        })
    {
        anyhow::bail!("work package dependencies are not accepted");
    }
    if to == WorkPackageStatus::Running {
        let session = work_session_id
            .as_deref()
            .filter(|session| !session.trim().is_empty())
            .ok_or_else(|| anyhow::anyhow!("running work requires a WorkSession id"))?;
        if packages.values().any(|package| {
            package.id != id
                && package.status == WorkPackageStatus::Running
                && package.worktree == current.worktree
        }) {
            anyhow::bail!("two running work packages cannot share a writable worktree");
        }
        if packages
            .values()
            .any(|package| package.id != id && package.work_session_id.as_deref() == Some(session))
        {
            anyhow::bail!("a WorkSession cannot control two work packages");
        }
    }
    if to == WorkPackageStatus::Candidate && candidate.is_none() {
        anyhow::bail!("candidate status requires immutable commit/tree evidence");
    }
    if let Some(candidate) = candidate.as_ref() {
        validate_text("candidate repository", &candidate.repository, 2_000)?;
        validate_git_object("candidate commit", &candidate.commit)?;
        validate_git_object("candidate tree", &candidate.tree)?;
        validate_evidence("candidate evidence", &candidate.evidence)?;
    }
    if matches!(to, WorkPackageStatus::Review | WorkPackageStatus::Accepted) {
        let candidate = current
            .candidate
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("review or acceptance requires a candidate"))?;
        let review = review
            .as_ref()
            .or(current.review.as_ref())
            .ok_or_else(|| anyhow::anyhow!("review status requires a Review WorkSession"))?;
        validate_text("review WorkSession id", &review.session_id, 200)?;
        validate_git_object("review candidate commit", &review.candidate_commit)?;
        validate_git_object("review candidate tree", &review.candidate_tree)?;
        validate_evidence("review evidence", &review.evidence)?;
        if review.candidate_commit != candidate.commit || review.candidate_tree != candidate.tree {
            anyhow::bail!("review must bind the current candidate commit and tree");
        }
    }
    if to == WorkPackageStatus::Accepted {
        let review = review.as_ref().or(current.review.as_ref());
        if review.and_then(|review| review.verdict) != Some(ReviewVerdict::Pass) {
            anyhow::bail!("accepted status requires an independent passing review");
        }
    }

    let package = packages.get_mut(id).expect("checked package exists");
    package.status = to;
    if to == WorkPackageStatus::Ready {
        // A Ready transition starts a fresh implementation attempt. Retaining
        // the prior WorkSession or candidate would make `agent run` reject the
        // package and would let stale review evidence bleed into the retry.
        package.work_session_id = None;
        package.candidate = None;
        package.review = None;
    }
    if work_session_id.is_some() {
        package.work_session_id = work_session_id;
    }
    if candidate.is_some() {
        package.candidate = candidate;
        package.review = None;
    }
    if review.is_some() {
        package.review = review;
    }
    package.block_reason = if to == WorkPackageStatus::Blocked {
        Some(
            block_reason
                .filter(|reason| !reason.trim().is_empty())
                .ok_or_else(|| anyhow::anyhow!("blocked status requires a reason"))?,
        )
    } else {
        None
    };
    package.updated_at_ms = now_ms;
    Ok(())
}

fn validate_git_object(label: &str, value: &str) -> Result<()> {
    if !matches!(value.len(), 40 | 64) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        anyhow::bail!("{label} must be a full Git object id");
    }
    Ok(())
}

fn validate_evidence(label: &str, values: &[String]) -> Result<()> {
    if values.is_empty() || values.len() > 128 {
        anyhow::bail!("{label} must contain 1-128 entries");
    }
    if values
        .iter()
        .any(|value| value.trim().is_empty() || value.len() > 4_000)
    {
        anyhow::bail!("{label} entries must be 1-4000 characters");
    }
    Ok(())
}

fn allowed(from: WorkPackageStatus, to: WorkPackageStatus) -> bool {
    use WorkPackageStatus::*;
    matches!(
        (from, to),
        (Planned, Ready | Blocked | Cancelled)
            | (Ready, Running | Blocked | Cancelled)
            | (Running, Waiting | Candidate | Blocked | Cancelled)
            | (Waiting, Running | Blocked | Cancelled)
            | (Candidate, Review | Ready | Blocked | Cancelled)
            | (Review, Accepted | Ready | Blocked | Cancelled)
            | (Blocked, Ready | Cancelled)
    )
}
