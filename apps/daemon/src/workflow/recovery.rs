//! Platform ceilings for a package-selected recovery flow.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Handle {
    pub run_id: String,
    pub trigger_seq: u64,
    pub reason: String,
}

pub(super) fn budget_exhausted(runtime: &super::RuntimeStore, run: &super::RunRecord, now: i64) -> Result<bool> {
    let budget = run.definition.budget.clone().unwrap_or_default();
    budget.validate()?;
    let group = super::request_runs(runtime, super::request::group_id(run))?;
    let mut rounds = 0u64;
    let mut execution_ms = 0u64;
    for recovery in group.iter().filter(|other| !other.handles.is_empty()) {
        rounds = rounds.saturating_add(super::request::activities(recovery)
            .fold(0u64, |sum, activity| sum.saturating_add(activity.llm_rounds)));
        execution_ms = execution_ms.saturating_add(super::request::execution_ms(recovery, now) as u64);
    }
    Ok(rounds >= budget.max_llm_rounds
        || execution_ms >= budget.deadline_seconds.saturating_mul(1000))
}

pub(super) const DEFAULT_PM_ANSWER_SECONDS: u64 = 1800;
pub(super) const MAX_PM_ANSWER_SECONDS: u64 = 86400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RecoveryBudget {
    pub max_runs: u32,
    pub max_llm_rounds: u64,
    pub deadline_seconds: u64,
}

impl Default for RecoveryBudget {
    fn default() -> Self {
        Self { max_runs: 3, max_llm_rounds: 200, deadline_seconds: 3600 }
    }
}

impl RecoveryBudget {
    pub(super) fn validate(&self) -> Result<()> {
        if !(1..=10).contains(&self.max_runs) {
            bail!("recovery budget.maxRuns 必须在 1..=10 之间");
        }
        if !(1..=1000).contains(&self.max_llm_rounds) {
            bail!("recovery budget.maxLlmRounds 必须在 1..=1000 之间");
        }
        if !(1..=86400).contains(&self.deadline_seconds) {
            bail!("recovery budget.deadlineSeconds 必须在 1..=86400 之间");
        }
        Ok(())
    }
}
