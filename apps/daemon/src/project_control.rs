//! Human-approved project mutations and PM control ownership.
//!
//! A plan challenge is intentionally not a bearer credential. It becomes a
//! one-use mutation grant only when an authenticated Human answers the exact
//! stopped interaction that the Session Manager associated with that
//! challenge. Agents receive only plan and action ids; the grant never leaves
//! daemon memory or its owner-only binding store.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, bail, Context, Result};
use genehub_proto::{
    AgentSpaceOperation, BootstrapApprovalChallenge, PermissionOption, PermissionOptionKind,
    PermissionOutcome, PermissionRequest, PermissionRequestKind,
};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::{Mutex, MutexGuard};

const CHALLENGE_TTL_MS: i64 = 10 * 60 * 1_000;
const APPROVE: &str = "approve-once";
const REJECT: &str = "reject";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChallengeSpec {
    pub controller_session_id: String,
    pub workspace_id: String,
    pub canonical_root: String,
    pub action: String,
    pub pack_id: String,
    pub pack_digest: String,
    pub plan_digest: String,
    pub expected_revision: u64,
    pub git_head: Option<String>,
    pub status_digest: String,
    pub title: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Challenge {
    #[serde(default)]
    management_binding: Option<String>,
    spec: ChallengeSpec,
    id: String,
    expires_at_ms: i64,
    request_id: Option<String>,
    approved: bool,
    rejected: bool,
    reserved_action_id: Option<String>,
    applying: bool,
    #[serde(default)]
    consumed: bool,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct State {
    challenges: HashMap<String, Challenge>,
    #[serde(skip)]
    request_to_challenge: HashMap<(String, String), String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectControlBinding {
    schema: String,
    workspace_id: String,
    controller_session_id: String,
    pack_id: String,
    pack_digest: String,
    issued_at_ms: i64,
}

#[derive(Clone)]
pub struct Broker {
    state: Arc<Mutex<State>>,
    root: PathBuf,
    /// Serializes project-control mutations while a transaction revalidates
    /// and applies the plan it just consumed.
    mutation: Arc<Mutex<()>>,
}

impl Broker {
    pub fn new(data_root: &Path) -> Result<Self> {
        let root = data_root.join("project-control");
        let mut state: State = match std::fs::read(root.join("approvals.json")) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).context("reading persisted project approvals")?
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => State::default(),
            Err(error) => return Err(error.into()),
        };
        for challenge in state.challenges.values() {
            if let Some(request) = &challenge.request_id {
                state.request_to_challenge.insert(
                    (
                        challenge.spec.controller_session_id.clone(),
                        request.clone(),
                    ),
                    challenge.id.clone(),
                );
            }
        }
        Ok(Self {
            state: Arc::new(Mutex::new(state)),
            root,
            mutation: Arc::new(Mutex::new(())),
        })
    }

    fn save(&self, guard: &mut State, next: State) -> Result<()> {
        crate::config::save_private(
            &self.root.join("approvals.json"),
            &serde_json::to_vec(&next)?,
        )?;
        *guard = next;
        Ok(())
    }

    pub async fn mutation_lock(&self) -> MutexGuard<'_, ()> {
        self.mutation.lock().await
    }

    /// A previously granted project binding is a distinct authority source;
    /// it never masquerades as a Human answer to a pending approval.
    pub(crate) async fn issue_management(
        &self,
        spec: ChallengeSpec,
        project_workspace_id: &str,
    ) -> Result<Option<BootstrapApprovalChallenge>> {
        let controller = spec.controller_session_id.clone();
        let challenge = self.issue(spec).await?;
        if !self.is_bound(project_workspace_id, &controller) {
            return Ok(Some(challenge));
        }
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let record = state
            .challenges
            .get_mut(&challenge.challenge_id)
            .ok_or_else(|| anyhow!("management plan disappeared"))?;
        record.management_binding = Some(project_workspace_id.into());
        self.save(&mut guard, state)?;
        Ok(None)
    }

    pub async fn issue(&self, spec: ChallengeSpec) -> Result<BootstrapApprovalChallenge> {
        let now = now_ms();
        let id = format!("pm-bootstrap-{}", uuid::Uuid::new_v4().simple());
        let challenge = Challenge {
            management_binding: None,
            spec: spec.clone(),
            id: id.clone(),
            expires_at_ms: now.saturating_add(CHALLENGE_TTL_MS),
            request_id: None,
            approved: false,
            rejected: false,
            reserved_action_id: None,
            applying: false,
            consumed: false,
        };
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let superseded = state
            .challenges
            .iter()
            .filter(|(_, existing)| {
                existing.spec.controller_session_id == spec.controller_session_id
                    && existing.spec.action == spec.action
            })
            .map(|(known_id, _)| known_id.clone())
            .collect::<Vec<_>>();
        for known_id in &superseded {
            state.challenges.remove(known_id);
        }
        state
            .request_to_challenge
            .retain(|_, known_id| !superseded.contains(known_id));
        state.challenges.insert(id.clone(), challenge);
        self.save(&mut guard, state)?;
        Ok(BootstrapApprovalChallenge {
            challenge_id: id,
            title: spec.title,
            detail: spec.detail,
            expires_at_ms: now.saturating_add(CHALLENGE_TTL_MS),
        })
    }

    /// Replaces an Agent-authored question with the daemon-authored plan card
    /// only when its opaque question id names a live challenge for this exact
    /// Session. Every other question remains an ordinary question.
    pub async fn normalize_request(
        &self,
        session_id: &str,
        request: &PermissionRequest,
    ) -> Result<PermissionRequest> {
        let Some(challenge_id) = request
            .questions
            .as_ref()
            .and_then(|questions| (questions.len() == 1).then_some(&questions[0]))
            .map(|question| question.id.as_str())
        else {
            return Ok(request.clone());
        };
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let now = now_ms();
        let Some(challenge) = state.challenges.get_mut(challenge_id) else {
            return Ok(request.clone());
        };
        if challenge.expires_at_ms < now
            || challenge.spec.controller_session_id != session_id
            || challenge.rejected
            || challenge.approved
        {
            return Ok(request.clone());
        }
        if let Some(existing_request_id) = challenge.request_id.as_deref() {
            return Ok(if existing_request_id == request.id {
                plan_permission_request(
                    request.id.clone(),
                    challenge.spec.title.clone(),
                    challenge.spec.detail.clone(),
                    request.tool_call_id.clone(),
                )
            } else {
                request.clone()
            });
        }
        challenge.request_id = Some(request.id.clone());
        let challenge_key = challenge.id.clone();
        let title = challenge.spec.title.clone();
        let detail = challenge.spec.detail.clone();
        state
            .request_to_challenge
            .insert((session_id.to_string(), request.id.clone()), challenge_key);
        self.save(&mut guard, state)?;
        Ok(plan_permission_request(
            request.id.clone(),
            title,
            detail,
            request.tool_call_id.clone(),
        ))
    }

    /// Turns one live, same-Session plan challenge into a Human-facing
    /// interaction without granting any authority. This is the portable
    /// fallback for Agent runtimes that do not expose a native structured
    /// question tool: the SessionController may present the card, but only an
    /// authenticated Human can answer it and create the one-use grant.
    pub async fn request_permission(
        &self,
        session_id: &str,
        challenge_id: &str,
    ) -> Result<(PermissionRequest, i64)> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let now = now_ms();
        let challenge = state
            .challenges
            .get_mut(challenge_id)
            .ok_or_else(|| anyhow!("approvalStale: this plan challenge no longer exists"))?;
        if challenge.expires_at_ms < now {
            bail!("approvalStale: this plan challenge expired; create a new plan");
        }
        if challenge.spec.controller_session_id != session_id {
            bail!("approvalStale: this plan challenge belongs to another Session");
        }
        if challenge.rejected || challenge.approved {
            bail!("approvalStale: this plan challenge was already resolved");
        }
        if let Some(id) = &challenge.request_id {
            return Ok((
                plan_permission_request(
                    id.clone(),
                    challenge.spec.title.clone(),
                    challenge.spec.detail.clone(),
                    None,
                ),
                challenge.expires_at_ms,
            ));
        }

        let request_id = format!("project-approval-{}", uuid::Uuid::new_v4().simple());
        challenge.request_id = Some(request_id.clone());
        let challenge_key = challenge.id.clone();
        let title = challenge.spec.title.clone();
        let detail = challenge.spec.detail.clone();
        let expires_at_ms = challenge.expires_at_ms;
        state
            .request_to_challenge
            .insert((session_id.to_string(), request_id.clone()), challenge_key);
        self.save(&mut guard, state)?;
        Ok((
            plan_permission_request(request_id, title, detail, None),
            expires_at_ms,
        ))
    }

    pub async fn is_plan_request(&self, session_id: &str, request_id: &str) -> bool {
        self.state
            .lock()
            .await
            .request_to_challenge
            .contains_key(&(session_id.to_string(), request_id.to_string()))
    }

    /// Releases a presentation that never reached a Human answer (for
    /// example, Session persistence failed or the challenge expired). It does
    /// not undo an approval or rejection.
    pub async fn abandon_request(&self, session_id: &str, request_id: &str) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let key = (session_id.to_string(), request_id.to_string());
        let Some(challenge_id) = state.request_to_challenge.remove(&key) else {
            return Ok(());
        };
        if let Some(challenge) = state.challenges.get_mut(&challenge_id) {
            if challenge.request_id.as_deref() == Some(request_id)
                && !challenge.approved
                && !challenge.rejected
            {
                challenge.request_id = None;
            }
        }
        self.save(&mut guard, state)
    }

    pub async fn record_human_response(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: &PermissionOutcome,
    ) -> Result<()> {
        self.record_human_response_at(session_id, request_id, outcome, now_ms())
            .await
    }

    pub async fn validate_human_response(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: &PermissionOutcome,
    ) -> Result<()> {
        let state = self.state.lock().await;
        let challenge = state
            .request_to_challenge
            .get(&(session_id.into(), request_id.into()))
            .and_then(|id| state.challenges.get(id))
            .ok_or_else(|| anyhow!("approvalStale: this plan challenge is no longer active"))?;
        validate_decision(challenge, outcome, now_ms())
    }

    pub async fn record_human_response_at(
        &self,
        session_id: &str,
        request_id: &str,
        outcome: &PermissionOutcome,
        decided_at_ms: i64,
    ) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let key = (session_id.to_string(), request_id.to_string());
        let challenge_id = state
            .request_to_challenge
            .get(&key)
            .cloned()
            .ok_or_else(|| anyhow!("approvalStale: this plan challenge is no longer active"))?;
        let challenge = state
            .challenges
            .get_mut(&challenge_id)
            .ok_or_else(|| anyhow!("approvalStale: this plan challenge no longer exists"))?;
        validate_decision(challenge, outcome, decided_at_ms)?;
        match outcome {
            PermissionOutcome::Selected { option_id } if option_id == APPROVE => {
                challenge.approved = true;
            }
            PermissionOutcome::Selected { option_id } if option_id == REJECT => {
                challenge.rejected = true;
            }
            PermissionOutcome::Canceled | PermissionOutcome::TimedOut { .. } => {
                challenge.rejected = true;
            }
            _ => bail!("approvalStale: invalid answer for a project mutation plan"),
        }
        self.save(&mut guard, state)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn reserve(
        &self,
        controller_session_id: &str,
        workspace_id: &str,
        canonical_root: &str,
        action: &str,
        pack_id: &str,
        pack_digest: &str,
        plan_digest: &str,
        expected_revision: u64,
        git_head: Option<&str>,
        status_digest: &str,
        action_id: &str,
    ) -> Result<String> {
        validate_action_id(action_id)?;
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let challenge = state
            .challenges
            .values_mut()
            .find(|challenge| {
                (challenge.approved
                    || challenge
                        .management_binding
                        .as_ref()
                        .is_some_and(|project| self.is_bound(project, controller_session_id)))
                    && !challenge.rejected
                    && !challenge.consumed
                    && challenge.spec.controller_session_id == controller_session_id
                    && challenge.spec.workspace_id == workspace_id
                    && challenge.spec.canonical_root == canonical_root
                    && challenge.spec.action == action
                    && challenge.spec.pack_id == pack_id
                    && challenge.spec.pack_digest == pack_digest
                    && challenge.spec.plan_digest == plan_digest
            })
            .ok_or_else(|| {
                anyhow!("approvalRequired: ask the user to approve the current daemon-issued plan")
            })?;
        if challenge.expires_at_ms < now_ms()
            || challenge.spec.expected_revision != expected_revision
            || challenge.spec.git_head.as_deref() != git_head
            || challenge.spec.status_digest != status_digest
        {
            bail!("approvalStale: project facts changed; create and approve a new plan");
        }
        match challenge.reserved_action_id.as_deref() {
            None => {
                challenge.reserved_action_id = Some(action_id.to_string());
                challenge.applying = true;
            }
            Some(existing) if existing == action_id && !challenge.applying => {
                challenge.applying = true;
            }
            Some(existing) if existing == action_id => {
                bail!("actionInProgress: this project mutation is already running")
            }
            Some(_) => bail!("approvalConsumed: this approval was already used"),
        }
        let id = challenge.id.clone();
        self.save(&mut guard, state)?;
        Ok(id)
    }

    pub async fn release_failed(&self, challenge_id: &str, action_id: &str) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        if let Some(challenge) = state.challenges.get_mut(challenge_id) {
            if challenge.reserved_action_id.as_deref() == Some(action_id) {
                challenge.applying = false;
            }
        }
        self.save(&mut guard, state)
    }

    pub async fn complete(&self, challenge_id: &str, action_id: &str) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        if let Some(challenge) = state.challenges.get_mut(challenge_id) {
            if challenge.reserved_action_id.as_deref() == Some(action_id) {
                challenge.consumed = true;
                challenge.applying = false;
            }
        }
        self.save(&mut guard, state)
    }

    pub async fn revoke_session(&self, session_id: &str) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let removed = state
            .challenges
            .iter()
            .filter(|(_, challenge)| challenge.spec.controller_session_id == session_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &removed {
            state.challenges.remove(id);
        }
        state
            .request_to_challenge
            .retain(|(session, _), challenge| {
                session != session_id && !removed.contains(challenge)
            });
        self.save(&mut guard, state)
    }

    /// Revokes every pending mutation whose exact target is being removed.
    ///
    /// Challenges are durable but deliberately cannot survive the
    /// disappearance/reopening of a Workspace identity. Project bindings are
    /// removed separately because they are durable authority.
    pub async fn revoke_workspace(&self, workspace_id: &str) -> Result<()> {
        let mut guard = self.state.lock().await;
        let mut state = guard.clone();
        let removed = state
            .challenges
            .iter()
            .filter(|(_, challenge)| challenge.spec.workspace_id == workspace_id)
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in &removed {
            state.challenges.remove(id);
        }
        state
            .request_to_challenge
            .retain(|_, challenge| !removed.contains(challenge));
        self.save(&mut guard, state)
    }

    pub fn bind(
        &self,
        workspace_id: &str,
        controller_session_id: &str,
        pack_id: &str,
        pack_digest: &str,
    ) -> Result<()> {
        validate_path_id(workspace_id, "workspace id")?;
        let binding = ProjectControlBinding {
            schema: "genehub.project-control-binding.v1".into(),
            workspace_id: workspace_id.into(),
            controller_session_id: controller_session_id.into(),
            pack_id: pack_id.into(),
            pack_digest: pack_digest.into(),
            issued_at_ms: now_ms(),
        };
        crate::config::save_private(
            &self.binding_path(workspace_id),
            &serde_json::to_vec_pretty(&binding)?,
        )
    }

    pub fn is_bound(&self, workspace_id: &str, controller_session_id: &str) -> bool {
        self.load_binding(workspace_id)
            .is_ok_and(|binding| binding.controller_session_id == controller_session_id)
    }

    pub fn remove_binding(&self, workspace_id: &str) -> Result<()> {
        let path = self.binding_path(workspace_id);
        match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).with_context(|| format!("removing {}", path.display())),
        }
    }

    /// Removes the durable project-control binding only when the Session being
    /// deleted is its current controller. The returned bytes allow the caller
    /// to restore authority if Session deletion itself fails.
    pub(crate) fn remove_binding_for_session(
        &self,
        workspace_id: &str,
        controller_session_id: &str,
    ) -> Result<Option<Vec<u8>>> {
        let Some(snapshot) = self.binding_snapshot(workspace_id)? else {
            return Ok(None);
        };
        let binding: ProjectControlBinding = serde_json::from_slice(&snapshot)
            .with_context(|| format!("reading project control binding for {workspace_id}"))?;
        if binding.controller_session_id != controller_session_id {
            return Ok(None);
        }
        self.remove_binding(workspace_id)?;
        Ok(Some(snapshot))
    }

    pub(crate) fn binding_snapshot(&self, workspace_id: &str) -> Result<Option<Vec<u8>>> {
        let path = self.binding_path(workspace_id);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error).with_context(|| format!("reading {}", path.display())),
        }
    }

    pub(crate) fn restore_binding_snapshot(
        &self,
        workspace_id: &str,
        snapshot: Option<&[u8]>,
    ) -> Result<()> {
        match snapshot {
            Some(bytes) => crate::config::save_private(&self.binding_path(workspace_id), bytes),
            None => self.remove_binding(workspace_id),
        }
    }

    /// Returns the exact result of a successful mutation replay. This is a
    /// daemon-private idempotency receipt, not a bearer credential.
    pub fn completed_action<T: DeserializeOwned>(
        &self,
        workspace_id: &str,
        controller_session_id: &str,
        action: &str,
        plan_digest: &str,
        action_id: &str,
    ) -> Result<Option<T>> {
        validate_path_id(workspace_id, "workspace id")?;
        validate_action_id(action_id)?;
        let bytes = match std::fs::read(self.action_path(workspace_id, action_id)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let receipt: CompletedAction = serde_json::from_slice(&bytes)?;
        if receipt.workspace_id != workspace_id
            || receipt.controller_session_id != controller_session_id
            || receipt.action != action
            || receipt.action_id != action_id
            || receipt.plan_digest != plan_digest
        {
            bail!("actionIdConflict: this action id already names another project mutation");
        }
        Ok(Some(serde_json::from_value(receipt.result)?))
    }

    pub fn record_completed_action<T: Serialize>(
        &self,
        workspace_id: &str,
        controller_session_id: &str,
        action: &str,
        plan_digest: &str,
        action_id: &str,
        result: &T,
    ) -> Result<()> {
        validate_path_id(workspace_id, "workspace id")?;
        validate_action_id(action_id)?;
        let receipt = CompletedAction {
            schema: "genehub.project-mutation-receipt.v1".into(),
            workspace_id: workspace_id.into(),
            controller_session_id: controller_session_id.into(),
            action: action.into(),
            plan_digest: plan_digest.into(),
            action_id: action_id.into(),
            completed_at_ms: now_ms(),
            result: serde_json::to_value(result)?,
        };
        crate::config::save_private(
            &self.action_path(workspace_id, action_id),
            &serde_json::to_vec_pretty(&receipt)?,
        )
    }

    fn load_binding(&self, workspace_id: &str) -> Result<ProjectControlBinding> {
        validate_path_id(workspace_id, "workspace id")?;
        let bytes = std::fs::read(self.binding_path(workspace_id))?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    fn binding_path(&self, workspace_id: &str) -> PathBuf {
        self.root
            .join("bindings")
            .join(format!("{workspace_id}.json"))
    }

    fn action_path(&self, workspace_id: &str, action_id: &str) -> PathBuf {
        self.root
            .join("actions")
            .join(workspace_id)
            .join(format!("{action_id}.json"))
    }
}

fn validate_decision(
    challenge: &Challenge,
    outcome: &PermissionOutcome,
    decided_at_ms: i64,
) -> Result<()> {
    let approved = match outcome {
        PermissionOutcome::Selected { option_id } if option_id == APPROVE => true,
        PermissionOutcome::Selected { option_id } if option_id == REJECT => false,
        PermissionOutcome::Canceled | PermissionOutcome::TimedOut { .. } => false,
        _ => bail!("approvalStale: invalid Human decision"),
    };
    if challenge.approved || challenge.rejected {
        if challenge.approved == approved {
            return Ok(());
        }
        bail!("approvalStale: this plan already has a different Human decision");
    }
    if approved
        && (decided_at_ms > challenge.expires_at_ms
            || decided_at_ms < challenge.expires_at_ms - CHALLENGE_TTL_MS)
    {
        bail!("approvalStale: this plan challenge expired; create a new plan");
    }
    Ok(())
}

fn plan_permission_request(
    id: String,
    title: String,
    detail: String,
    tool_call_id: Option<String>,
) -> PermissionRequest {
    PermissionRequest {
        id,
        kind: PermissionRequestKind::PlanApproval,
        title,
        detail: Some(detail),
        tool_call_id,
        options: vec![
            PermissionOption {
                id: APPROVE.into(),
                label: "确认并仅执行这一次".into(),
                kind: PermissionOptionKind::AllowOnce,
            },
            PermissionOption {
                id: REJECT.into(),
                label: "暂不接管".into(),
                kind: PermissionOptionKind::Reject,
            },
        ],
        questions: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompletedAction {
    schema: String,
    workspace_id: String,
    controller_session_id: String,
    action: String,
    plan_digest: String,
    action_id: String,
    completed_at_ms: i64,
    result: serde_json::Value,
}

fn validate_action_id(value: &str) -> Result<()> {
    validate_path_id(value, "action id")
}

fn validate_path_id(value: &str, label: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        bail!("{label} is invalid");
    }
    Ok(())
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub(crate) fn agent_space_plan_digest(
    workspace_id: &str,
    canonical_root: &str,
    expected_revision: u64,
    builder_lock_digest: &str,
    operation: &AgentSpaceOperation,
) -> Result<String> {
    let operation = serde_json::to_vec(operation)?;
    let mut digest = Sha256::new();
    digest.update(b"genehub.agent-space-change-plan.v1\0");
    for value in [workspace_id, canonical_root, builder_lock_digest] {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value.as_bytes());
    }
    digest.update(expected_revision.to_le_bytes());
    digest.update((operation.len() as u64).to_le_bytes());
    digest.update(operation);
    Ok(format!("sha256:{:x}", digest.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use genehub_proto::{InteractionOption, InteractionQuestion};

    fn spec() -> ChallengeSpec {
        ChallengeSpec {
            controller_session_id: "s_pm".into(),
            workspace_id: "w_project".into(),
            canonical_root: "/project".into(),
            action: "project.bootstrap.apply".into(),
            pack_id: "game-delivery-v1".into(),
            pack_digest: "sha256:pack".into(),
            plan_digest: "sha256:plan".into(),
            expected_revision: 0,
            git_head: None,
            status_digest: "sha256:clean".into(),
            title: "接管项目？".into(),
            detail: "创建 PM 团队".into(),
        }
    }

    fn question(id: &str) -> PermissionRequest {
        PermissionRequest {
            id: "ask_1".into(),
            kind: PermissionRequestKind::Question,
            title: "agent text".into(),
            detail: None,
            tool_call_id: Some("tool_1".into()),
            options: Vec::new(),
            questions: Some(vec![InteractionQuestion {
                id: id.into(),
                prompt: "agent prompt".into(),
                allow_multiple: false,
                allow_freeform: true,
                options: vec![InteractionOption {
                    id: "0".into(),
                    label: "yes".into(),
                }],
            }]),
        }
    }

    #[tokio::test]
    async fn only_the_matching_session_question_becomes_a_plan_approval() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();
        let foreign = broker
            .normalize_request("s_other", &question(&issued.challenge_id))
            .await
            .unwrap();
        assert_eq!(foreign.kind, PermissionRequestKind::Question);
        let normalized = broker
            .normalize_request("s_pm", &question(&issued.challenge_id))
            .await
            .unwrap();
        assert_eq!(normalized.kind, PermissionRequestKind::PlanApproval);
        assert_eq!(normalized.title, "接管项目？");
        assert!(normalized.questions.is_none());

        broker.issue(spec()).await.unwrap();
        assert!(
            !broker.is_plan_request("s_pm", "ask_1").await,
            "a superseded plan left its old request mapped to authority"
        );
    }

    #[tokio::test]
    async fn a_session_can_present_its_own_challenge_without_approving_it() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();

        assert!(broker
            .request_permission("s_other", &issued.challenge_id)
            .await
            .is_err());
        let (request, expires_at_ms) = broker
            .request_permission("s_pm", &issued.challenge_id)
            .await
            .unwrap();

        assert_eq!(expires_at_ms, issued.expires_at_ms);
        assert_eq!(request.kind, PermissionRequestKind::PlanApproval);
        assert_eq!(request.title, "接管项目？");
        assert_eq!(request.options.len(), 2);
        assert!(broker.is_plan_request("s_pm", &request.id).await);
        assert!(broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap-before-human",
            )
            .await
            .is_err());
        assert_eq!(
            broker
                .request_permission("s_pm", &issued.challenge_id)
                .await
                .unwrap()
                .0
                .id,
            request.id
        );
    }

    #[tokio::test]
    async fn approval_is_single_session_single_plan_and_single_action() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();
        broker
            .normalize_request("s_pm", &question(&issued.challenge_id))
            .await
            .unwrap();
        broker
            .record_human_response(
                "s_pm",
                "ask_1",
                &PermissionOutcome::Selected {
                    option_id: APPROVE.into(),
                },
            )
            .await
            .unwrap();
        let challenge = broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_1",
            )
            .await
            .unwrap();
        assert!(broker
            .reserve(
                "s_other",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_2",
            )
            .await
            .is_err());
        broker.complete(&challenge, "bootstrap_1").await.unwrap();
        assert!(broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_2",
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn removing_a_workspace_revokes_its_pending_challenge() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();
        let normalized = broker
            .normalize_request("s_pm", &question(&issued.challenge_id))
            .await
            .unwrap();
        broker
            .record_human_response(
                "s_pm",
                &normalized.id,
                &PermissionOutcome::Selected {
                    option_id: APPROVE.into(),
                },
            )
            .await
            .unwrap();

        broker.revoke_workspace("w_project").await.unwrap();
        assert!(broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_after_remove",
            )
            .await
            .is_err());
    }

    #[test]
    fn deleting_the_controller_session_removes_only_its_binding() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        broker
            .bind("w_project", "s_pm", "game-delivery-v1", "sha256:pack")
            .unwrap();

        assert!(broker
            .remove_binding_for_session("w_project", "s_other")
            .unwrap()
            .is_none());
        assert!(broker.is_bound("w_project", "s_pm"));

        let snapshot = broker
            .remove_binding_for_session("w_project", "s_pm")
            .unwrap()
            .expect("the matching binding is removed transactionally");
        assert!(!broker.is_bound("w_project", "s_pm"));

        broker
            .restore_binding_snapshot("w_project", Some(&snapshot))
            .unwrap();
        assert!(broker.is_bound("w_project", "s_pm"));
    }

    #[tokio::test]
    async fn rejection_and_fact_drift_never_create_a_spendable_grant() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let rejected = broker.issue(spec()).await.unwrap();
        broker
            .normalize_request("s_pm", &question(&rejected.challenge_id))
            .await
            .unwrap();
        broker
            .record_human_response(
                "s_pm",
                "ask_1",
                &PermissionOutcome::Selected {
                    option_id: REJECT.into(),
                },
            )
            .await
            .unwrap();
        assert!(broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "rejected_action",
            )
            .await
            .is_err());

        let approved = broker.issue(spec()).await.unwrap();
        broker
            .normalize_request("s_pm", &question(&approved.challenge_id))
            .await
            .unwrap();
        broker
            .record_human_response(
                "s_pm",
                "ask_1",
                &PermissionOutcome::Selected {
                    option_id: APPROVE.into(),
                },
            )
            .await
            .unwrap();
        let stale = broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:changed",
                "stale_action",
            )
            .await
            .unwrap_err();
        assert!(stale.to_string().contains("approvalStale"));
    }

    #[tokio::test]
    async fn an_expired_challenge_cannot_be_normalized_or_approved() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();
        broker
            .state
            .lock()
            .await
            .challenges
            .get_mut(&issued.challenge_id)
            .unwrap()
            .expires_at_ms = now_ms() - 1;

        let untouched = broker
            .normalize_request("s_pm", &question(&issued.challenge_id))
            .await
            .unwrap();
        assert_eq!(untouched.kind, PermissionRequestKind::Question);
        assert!(broker
            .record_human_response(
                "s_pm",
                "ask_1",
                &PermissionOutcome::Selected {
                    option_id: APPROVE.into(),
                },
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn a_failed_action_can_only_retry_its_same_identity() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let issued = broker.issue(spec()).await.unwrap();
        broker
            .normalize_request("s_pm", &question(&issued.challenge_id))
            .await
            .unwrap();
        broker
            .record_human_response(
                "s_pm",
                "ask_1",
                &PermissionOutcome::Selected {
                    option_id: APPROVE.into(),
                },
            )
            .await
            .unwrap();
        let challenge = broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_1",
            )
            .await
            .unwrap();
        broker
            .release_failed(&challenge, "bootstrap_1")
            .await
            .unwrap();
        assert!(broker
            .reserve(
                "s_pm",
                "w_project",
                "/project",
                "project.bootstrap.apply",
                "game-delivery-v1",
                "sha256:pack",
                "sha256:plan",
                0,
                None,
                "sha256:clean",
                "bootstrap_2",
            )
            .await
            .is_err());
        assert_eq!(
            broker
                .reserve(
                    "s_pm",
                    "w_project",
                    "/project",
                    "project.bootstrap.apply",
                    "game-delivery-v1",
                    "sha256:pack",
                    "sha256:plan",
                    0,
                    None,
                    "sha256:clean",
                    "bootstrap_1",
                )
                .await
                .unwrap(),
            challenge
        );
    }

    #[test]
    fn completed_action_is_private_idempotency_not_a_cross_session_token() {
        let root = tempfile::tempdir().unwrap();
        let broker = Broker::new(root.path()).unwrap();
        let result = serde_json::json!({"status": "applied"});
        broker
            .record_completed_action(
                "w_project",
                "s_pm",
                "project.bootstrap.apply",
                "sha256:plan",
                "bootstrap_1",
                &result,
            )
            .unwrap();
        let replay: serde_json::Value = broker
            .completed_action(
                "w_project",
                "s_pm",
                "project.bootstrap.apply",
                "sha256:plan",
                "bootstrap_1",
            )
            .unwrap()
            .unwrap();
        assert_eq!(replay, result);
        assert!(broker
            .completed_action::<serde_json::Value>(
                "w_project",
                "s_other",
                "project.bootstrap.apply",
                "sha256:plan",
                "bootstrap_1",
            )
            .is_err());
    }
}
