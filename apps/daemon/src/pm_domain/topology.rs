use std::collections::BTreeSet;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSpaceResourceState {
    #[default]
    Idle,
    Checking,
    Reserved,
    Working,
    Returning,
    Quarantined,
    Repairing,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpaceLease {
    pub id: String,
    pub controller_session_id: String,
    pub work_package_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_session_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AgentSpaceRole {
    #[default]
    Implementation,
    Review,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSpaceRecord {
    pub name: String,
    pub purpose: String,
    pub source_path: PathBuf,
    pub workspace_id: String,
    pub source_commit: String,
    pub builder_lock_digest: String,
    #[serde(default)]
    pub role: AgentSpaceRole,
    /// Coordinator-visible capabilities used by Workflow Space selectors.
    /// They describe the Space role, never an Agent runtime or model.
    #[serde(default)]
    pub tags: BTreeSet<String>,
    /// Human-declared capability contract. `tags` is the effective union of
    /// this set and the one kernel-owned role tag; prose is never parsed.
    #[serde(default)]
    pub declared_tags: BTreeSet<String>,
    pub active: bool,
    #[serde(default)]
    pub resource_state: AgentSpaceResourceState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease: Option<AgentSpaceLease>,
    #[serde(default)]
    pub resource_revision: u64,
    pub updated_at_ms: i64,
}

impl AgentSpaceRecord {
    pub fn reserve(
        &mut self,
        lease_id: String,
        controller_session_id: String,
        work_package_id: String,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if !self.active {
            anyhow::bail!("inactive Agent Space cannot be reserved");
        }
        if self.resource_state != AgentSpaceResourceState::Idle || self.lease.is_some() {
            anyhow::bail!("Agent Space {} is not idle", self.name);
        }
        self.resource_state = AgentSpaceResourceState::Checking;
        self.bump(now_ms);
        self.lease = Some(AgentSpaceLease {
            id: lease_id,
            controller_session_id,
            work_package_id,
            work_session_id: None,
        });
        self.resource_state = AgentSpaceResourceState::Reserved;
        self.bump(now_ms);
        Ok(())
    }

    pub fn start_work(
        &mut self,
        lease_id: &str,
        work_session_id: String,
        now_ms: i64,
    ) -> anyhow::Result<()> {
        if self.resource_state != AgentSpaceResourceState::Reserved {
            anyhow::bail!("Agent Space {} has no reserved lease to start", self.name);
        }
        let lease = self
            .lease
            .as_mut()
            .filter(|lease| lease.id == lease_id)
            .ok_or_else(|| anyhow::anyhow!("Agent Space lease identity changed"))?;
        if lease.work_session_id.is_some() {
            anyhow::bail!("Agent Space lease already has a WorkSession");
        }
        lease.work_session_id = Some(work_session_id);
        self.resource_state = AgentSpaceResourceState::Working;
        self.bump(now_ms);
        Ok(())
    }

    pub fn return_after_check(&mut self, clean: bool, now_ms: i64) -> anyhow::Result<()> {
        // Quarantine is the durable result of an earlier dirty return. A
        // supervisor budget barrier or an idempotent package transition may
        // observe the same still-bound lease again; preserving that evidence
        // is already the safe terminal action. Only the explicit repair path
        // may re-check and release a quarantined Space.
        if self.resource_state == AgentSpaceResourceState::Quarantined {
            if self.lease.is_none() {
                anyhow::bail!(
                    "quarantined Agent Space {} lost its lease evidence",
                    self.name
                );
            }
            return Ok(());
        }
        if !matches!(
            self.resource_state,
            AgentSpaceResourceState::Reserved | AgentSpaceResourceState::Working
        ) {
            anyhow::bail!("Agent Space {} has no active lease to return", self.name);
        }
        self.resource_state = AgentSpaceResourceState::Returning;
        self.bump(now_ms);
        if clean {
            self.lease = None;
            self.resource_state = AgentSpaceResourceState::Idle;
        } else {
            self.resource_state = AgentSpaceResourceState::Quarantined;
        }
        self.bump(now_ms);
        Ok(())
    }

    pub fn begin_repair(&mut self, now_ms: i64) -> anyhow::Result<()> {
        if self.resource_state != AgentSpaceResourceState::Quarantined {
            anyhow::bail!("only a quarantined Agent Space can enter repair");
        }
        self.resource_state = AgentSpaceResourceState::Repairing;
        self.bump(now_ms);
        Ok(())
    }

    pub fn finish_repair_check(&mut self, clean: bool, now_ms: i64) -> anyhow::Result<()> {
        if self.resource_state != AgentSpaceResourceState::Repairing {
            anyhow::bail!("Agent Space repair has not started");
        }
        self.resource_state = AgentSpaceResourceState::Checking;
        self.bump(now_ms);
        if clean {
            self.lease = None;
            self.resource_state = AgentSpaceResourceState::Idle;
        } else {
            self.resource_state = AgentSpaceResourceState::Quarantined;
        }
        self.bump(now_ms);
        Ok(())
    }

    fn bump(&mut self, now_ms: i64) {
        self.resource_revision = self.resource_revision.saturating_add(1);
        self.updated_at_ms = now_ms;
    }
}
