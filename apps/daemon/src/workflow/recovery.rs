//! Platform ceilings for a package-selected recovery flow.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

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
