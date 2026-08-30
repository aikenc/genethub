use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const DCG_SCHEMA: &str = "genehub-pm-dcg.v1";
pub const DCG_CATALOG_SCHEMA: &str = "genehub-pm-dcg-catalog.v1";
pub const DEFAULT_RUN_WALL_CLOCK_MS: u64 = 10 * 60 * 1_000;
pub const DEFAULT_RUN_MAX_WORK_SESSIONS: u32 = 16;
pub const DEFAULT_RUN_MAX_CONCURRENT_WORK_SESSIONS: u32 = 4;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgCatalogFile {
    pub schema: String,
    pub recommended_session_workflow: String,
    pub session_workflows: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DcgCatalog {
    pub recommended_session_workflow: String,
    pub session_workflows: BTreeMap<String, DcgDefinition>,
    pub root: PathBuf,
}

impl DcgCatalog {
    pub fn load(skill_root: &Path) -> Result<Self> {
        let root = skill_root
            .canonicalize()
            .with_context(|| format!("workflow Skill is unavailable: {}", skill_root.display()))?;
        let raw = std::fs::read(root.join("catalog.yaml"))?;
        let catalog: DcgCatalogFile =
            serde_yaml::from_slice(&raw).context("project workflow catalog is not valid YAML")?;
        if catalog.schema != DCG_CATALOG_SCHEMA {
            anyhow::bail!("workflow catalog schema must be {DCG_CATALOG_SCHEMA}");
        }
        validate_id(
            "recommendedSessionWorkflow",
            &catalog.recommended_session_workflow,
        )?;
        if !catalog
            .session_workflows
            .contains_key(&catalog.recommended_session_workflow)
        {
            anyhow::bail!("recommended Session DCG is not present in sessionWorkflows");
        }
        if catalog.session_workflows.is_empty() {
            anyhow::bail!("workflow catalog must define at least one Session DCG");
        }

        let mut session_workflows = BTreeMap::new();
        for (id, relative) in catalog.session_workflows {
            validate_id("Session DCG id", &id)?;
            let path = resolve_resource(&root, &relative)?;
            let graph = DcgDefinition::load(&root, &path)?;
            if graph.kind != DcgKind::SessionWorkflow {
                anyhow::bail!("sessionWorkflows.{id} must reference a sessionWorkflow DCG");
            }
            if graph.id != id {
                anyhow::bail!("sessionWorkflows.{id} references DCG {}", graph.id);
            }
            session_workflows.insert(id, graph);
        }

        Ok(Self {
            recommended_session_workflow: catalog.recommended_session_workflow,
            session_workflows,
            root,
        })
    }

    pub fn session_workflow(&self, id: &str) -> Result<&DcgDefinition> {
        self.session_workflows
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("unknown Session DCG: {id}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgKind {
    SessionWorkflow,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgDefinition {
    pub schema: String,
    pub id: String,
    pub kind: DcgKind,
    pub version: u32,
    pub entry: String,
    /// Project-owned execution envelope. The kernel measures and enforces the
    /// envelope; prompts cannot extend it and a selected Run pins this value
    /// together with the rest of the Workflow definition.
    #[serde(default)]
    pub execution_budget: DcgExecutionBudget,
    pub nodes: Vec<DcgNode>,
    pub edges: Vec<DcgEdge>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgExecutionBudget {
    pub wall_clock_ms: u64,
    pub max_work_sessions: u32,
    pub max_concurrent_work_sessions: u32,
}

impl Default for DcgExecutionBudget {
    fn default() -> Self {
        Self {
            wall_clock_ms: DEFAULT_RUN_WALL_CLOCK_MS,
            max_work_sessions: DEFAULT_RUN_MAX_WORK_SESSIONS,
            max_concurrent_work_sessions: DEFAULT_RUN_MAX_CONCURRENT_WORK_SESSIONS,
        }
    }
}

impl DcgExecutionBudget {
    fn validate(&self) -> Result<()> {
        if !(60_000..=24 * 60 * 60 * 1_000).contains(&self.wall_clock_ms) {
            anyhow::bail!("executionBudget.wallClockMs must be between 60000 and 86400000");
        }
        if !(1..=128).contains(&self.max_work_sessions) {
            anyhow::bail!("executionBudget.maxWorkSessions must be 1-128");
        }
        if self.max_concurrent_work_sessions == 0
            || self.max_concurrent_work_sessions > self.max_work_sessions
        {
            anyhow::bail!("executionBudget.maxConcurrentWorkSessions must be 1-maxWorkSessions");
        }
        Ok(())
    }
}

impl DcgDefinition {
    fn load(skill_root: &Path, path: &Path) -> Result<Self> {
        let raw =
            std::fs::read(path).with_context(|| format!("reading PM DCG {}", path.display()))?;
        let definition: Self = serde_yaml::from_slice(&raw)
            .with_context(|| format!("PM DCG is not valid YAML: {}", path.display()))?;
        definition.validate(skill_root)?;
        Ok(definition)
    }

    pub fn validate(&self, resource_root: &Path) -> Result<()> {
        if self.schema != DCG_SCHEMA {
            anyhow::bail!("DCG schema must be {DCG_SCHEMA}");
        }
        validate_id("DCG id", &self.id)?;
        if self.version == 0 {
            anyhow::bail!("DCG version must be positive");
        }
        self.execution_budget.validate()?;
        if self.nodes.is_empty() {
            anyhow::bail!("DCG must define at least one node");
        }
        validate_id("DCG entry", &self.entry)?;

        let mut node_indices = BTreeMap::new();
        for (index, node) in self.nodes.iter().enumerate() {
            node.validate(resource_root)?;
            if node_indices.insert(node.id.clone(), index).is_some() {
                anyhow::bail!("duplicate DCG node: {}", node.id);
            }
        }
        if !node_indices.contains_key(&self.entry) {
            anyhow::bail!("DCG entry names an unknown node: {}", self.entry);
        }

        let mut edge_ids = BTreeSet::new();
        for edge in &self.edges {
            edge.validate()?;
            if !edge_ids.insert(edge.id.clone()) {
                anyhow::bail!("duplicate DCG edge: {}", edge.id);
            }
            let from = *node_indices
                .get(&edge.from)
                .ok_or_else(|| anyhow::anyhow!("edge {} has unknown from node", edge.id))?;
            let to = *node_indices
                .get(&edge.to)
                .ok_or_else(|| anyhow::anyhow!("edge {} has unknown to node", edge.id))?;
            if to <= from && edge.max_traversals.is_none() {
                anyhow::bail!("cyclic/back edge {} must declare maxTraversals", edge.id);
            }
        }

        for node in &self.nodes {
            let incoming = self
                .edges
                .iter()
                .filter(|edge| edge.to == node.id)
                .map(|edge| edge.from.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32;
            let outgoing = self
                .edges
                .iter()
                .filter(|edge| edge.from == node.id)
                .count();
            if node.fork.is_some() {
                let automatic = self
                    .edges
                    .iter()
                    .filter(|edge| edge.from == node.id && edge.choose_by.is_none())
                    .count();
                if automatic < 2 {
                    anyhow::bail!(
                        "fork node {} requires at least two automatic outgoing edges",
                        node.id
                    );
                }
            }
            match node.kind {
                DcgNodeKind::Join => {
                    if incoming == 0 {
                        anyhow::bail!("join node {} requires at least one incoming edge", node.id);
                    }
                    if let Some(JoinActivation::Quorum { quorum }) = node.activation.as_ref() {
                        if *quorum == 0 || *quorum > incoming {
                            anyhow::bail!(
                                "join node {} quorum must be between 1 and its {incoming} unique incoming nodes",
                                node.id
                            );
                        }
                    }
                }
                DcgNodeKind::Terminal if outgoing != 0 => {
                    anyhow::bail!("terminal node {} cannot have outgoing edges", node.id);
                }
                _ => {}
            }
        }

        let reachable = reachable_nodes(&self.entry, &self.edges);
        if reachable.len() != self.nodes.len() {
            let missing = self
                .nodes
                .iter()
                .filter(|node| !reachable.contains(&node.id))
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            anyhow::bail!("DCG contains unreachable nodes: {missing}");
        }
        if self.kind == DcgKind::SessionWorkflow {
            let terminals = self
                .nodes
                .iter()
                .filter(|node| node.kind == DcgNodeKind::Terminal)
                .map(|node| node.id.clone())
                .collect::<BTreeSet<_>>();
            if terminals.is_empty() {
                anyhow::bail!("Session DCG must contain a terminal node");
            }
            if !can_reach_any(&self.entry, &terminals, &self.edges) {
                anyhow::bail!("Session DCG entry cannot reach a terminal node");
            }
            let mut supervised_stops = terminals;
            supervised_stops.extend(
                self.nodes
                    .iter()
                    .filter(|node| {
                        node.executor
                            .as_ref()
                            .is_some_and(|executor| executor.actor == DcgActor::User)
                    })
                    .map(|node| node.id.clone()),
            );
            supervised_stops.extend(
                self.edges
                    .iter()
                    .filter(|edge| edge.choose_by == Some(DcgActor::User))
                    .map(|edge| edge.from.clone()),
            );
            let can_reach_supervision = nodes_that_can_reach_any(&supervised_stops, &self.edges);
            let trapped_cycle = self
                .nodes
                .iter()
                .filter(|node| {
                    node_is_in_cycle(&node.id, &self.edges)
                        && !can_reach_supervision.contains(&node.id)
                })
                .map(|node| node.id.as_str())
                .collect::<Vec<_>>();
            if !trapped_cycle.is_empty() {
                anyhow::bail!(
                    "DCG contains a closed autonomous cycle without terminal or user decision exit: {}",
                    trapped_cycle.join(", ")
                );
            }
        }
        Ok(())
    }

    pub fn node(&self, id: &str) -> Result<&DcgNode> {
        self.nodes
            .iter()
            .find(|node| node.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown DCG node: {id}"))
    }

    pub fn edge(&self, id: &str) -> Result<&DcgEdge> {
        self.edges
            .iter()
            .find(|edge| edge.id == id)
            .ok_or_else(|| anyhow::anyhow!("unknown DCG edge: {id}"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgNodeKind {
    Activity,
    Join,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgNode {
    pub id: String,
    pub kind: DcgNodeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<DcgExecutor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub objective: Option<DcgObjective>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fanout: Option<DcgFanout>,
    /// Explicit graph-level AND split. WorkPackage fanout remains the normal
    /// parallelism primitive; this flag is required before several automatic
    /// outgoing edges may fire from the same node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork: Option<DcgForkMode>,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activation: Option<JoinActivation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

impl DcgNode {
    fn validate(&self, resource_root: &Path) -> Result<()> {
        validate_id("DCG node id", &self.id)?;
        unique_ids("node input", &self.inputs)?;
        unique_ids("node output", &self.outputs)?;
        if !self.inputs.is_empty() {
            anyhow::bail!(
                "node {} inputs are not an executable MVP contract; remove them until a kernel consumer exists",
                self.id
            );
        }
        match self.kind {
            DcgNodeKind::Activity => {
                let executor = self.executor.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("activity node {} requires an executor", self.id)
                })?;
                executor.validate()?;
                if matches!(executor.actor, DcgActor::WorkAgent | DcgActor::System)
                    && !self.outputs.is_empty()
                {
                    anyhow::bail!(
                        "node {} WorkAgent/system facts are kernel-derived and cannot declare semantic outputs",
                        self.id
                    );
                }
                if let Some(objective) = &self.objective {
                    let prompt = resolve_resource(resource_root, &objective.prompt)?;
                    if !prompt.is_file() {
                        anyhow::bail!(
                            "activity node {} prompt is unavailable: {}",
                            self.id,
                            objective.prompt
                        );
                    }
                }
                if let Some(fanout) = &self.fanout {
                    fanout.validate()?;
                }
                if self.fanout.is_some() && self.fork.is_some() {
                    anyhow::bail!(
                        "activity node {} cannot nest WorkPackage fanout and a graph fork",
                        self.id
                    );
                }
                if self.activation.is_some() || self.outcome.is_some() {
                    anyhow::bail!("activity node {} has join/terminal-only fields", self.id);
                }
            }
            DcgNodeKind::Join => {
                if self.activation.is_none() {
                    anyhow::bail!("join node {} requires activation", self.id);
                }
                if self.executor.is_some()
                    || self.objective.is_some()
                    || self.fanout.is_some()
                    || self.fork.is_some()
                    || self.outcome.is_some()
                {
                    anyhow::bail!("join node {} has activity/terminal-only fields", self.id);
                }
                if !self.outputs.is_empty() {
                    anyhow::bail!("join node {} cannot declare semantic outputs", self.id);
                }
            }
            DcgNodeKind::Terminal => {
                if self.outcome.as_deref().is_none_or(str::is_empty) {
                    anyhow::bail!("terminal node {} requires outcome", self.id);
                }
                if self.executor.is_some()
                    || self.objective.is_some()
                    || self.fanout.is_some()
                    || self.fork.is_some()
                    || self.activation.is_some()
                {
                    anyhow::bail!("terminal node {} has activity/join-only fields", self.id);
                }
                if !self.outputs.is_empty() {
                    anyhow::bail!("terminal node {} cannot declare semantic outputs", self.id);
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgActor {
    Pm,
    WorkAgent,
    User,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgExecutor {
    pub actor: DcgActor,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space: Option<DcgSpaceSelector>,
}

impl DcgExecutor {
    fn validate(&self) -> Result<()> {
        match (self.actor, &self.space) {
            (DcgActor::WorkAgent, Some(space)) => space.validate(),
            (DcgActor::WorkAgent, None) => {
                anyhow::bail!("workAgent executor requires a Space selector")
            }
            (_, Some(_)) => anyhow::bail!("only workAgent executor may select a Space"),
            (_, None) => Ok(()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgSpaceSelector {
    #[serde(default)]
    pub match_tags: Vec<String>,
    pub lease: SpaceLeaseMode,
    #[serde(default)]
    pub clean_required: bool,
}

impl DcgSpaceSelector {
    fn validate(&self) -> Result<()> {
        unique_ids("Space selector tag", &self.match_tags)?;
        if self.match_tags.is_empty() {
            anyhow::bail!("workAgent Space selector requires at least one tag");
        }
        if !self.clean_required {
            anyhow::bail!(
                "workAgent Space selector cannot disable the kernel clean-worktree invariant"
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SpaceLeaseMode {
    Exclusive,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgObjective {
    pub prompt: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgFanout {
    /// Provenance key for the PM-planned collection. `foreach` remains an
    /// accepted alias for already-persisted V3 definitions; the kernel never
    /// evaluates an arbitrary expression at this path. Concrete items are the
    /// WorkPackages atomically bound to this node instance.
    #[serde(alias = "foreach")]
    pub source: String,
    pub max_items: u32,
}

impl DcgFanout {
    fn validate(&self) -> Result<()> {
        validate_fact("fanout.source", &self.source)?;
        if self.max_items == 0 || self.max_items > 32 {
            anyhow::bail!("fanout.maxItems must be 1-32");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgForkMode {
    AllEligible,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum JoinActivation {
    Named(JoinActivationKind),
    Quorum { quorum: u32 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JoinActivationKind {
    All,
    Any,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgEdge {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub from: String,
    pub to: String,
    pub when: DcgCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choose_by: Option<DcgActor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_traversals: Option<u32>,
}

impl DcgEdge {
    fn validate(&self) -> Result<()> {
        validate_id("DCG edge id", &self.id)?;
        if self
            .label
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 120)
        {
            anyhow::bail!("DCG edge label must be 1-120 characters");
        }
        if self
            .description
            .as_deref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 500)
        {
            anyhow::bail!("DCG edge description must be 1-500 characters");
        }
        validate_id("DCG edge from", &self.from)?;
        validate_id("DCG edge to", &self.to)?;
        self.when.validate()?;
        if matches!(self.choose_by, Some(DcgActor::WorkAgent)) {
            anyhow::bail!("WorkAgent cannot choose a DCG edge");
        }
        if self.max_traversals == Some(0) {
            anyhow::bail!("edge maxTraversals must be positive");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DcgCondition {
    Fact(String),
    All { all: Vec<DcgCondition> },
    Any { any: Vec<DcgCondition> },
    Not { not: Box<DcgCondition> },
}

impl DcgCondition {
    fn validate(&self) -> Result<()> {
        match self {
            Self::Fact(fact) => validate_fact("edge condition", fact),
            Self::All { all } => validate_conditions("all", all),
            Self::Any { any } => validate_conditions("any", any),
            Self::Not { not } => not.validate(),
        }
    }

    pub fn satisfied_by(&self, facts: &BTreeSet<String>) -> bool {
        match self {
            Self::Fact(fact) => facts.contains(fact),
            Self::All { all } => all.iter().all(|condition| condition.satisfied_by(facts)),
            Self::Any { any } => any.iter().any(|condition| condition.satisfied_by(facts)),
            Self::Not { not } => !not.satisfied_by(facts),
        }
    }

    /// Whether this condition structurally references one exact fact.
    /// Coordinator-owned commands use this to prove that typed evidence is
    /// relevant to the active Workflow node without hard-coding node ids.
    pub fn mentions_fact(&self, expected: &str) -> bool {
        match self {
            Self::Fact(fact) => fact == expected,
            Self::All { all } => all
                .iter()
                .any(|condition| condition.mentions_fact(expected)),
            Self::Any { any } => any
                .iter()
                .any(|condition| condition.mentions_fact(expected)),
            Self::Not { not } => not.mentions_fact(expected),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgRunStatus {
    Discussion,
    Active,
    /// The wall-clock deadline passed and the supervisor is interrupting the
    /// exact WorkSessions owned by this Run before resources are settled.
    BudgetExhausting,
    /// All owned WorkSessions settled and the Coordinator closed the Run
    /// without claiming delivery.
    BudgetExhausted,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcgRunBudget {
    pub wall_clock_ms: u64,
    pub max_work_sessions: u32,
    pub max_concurrent_work_sessions: u32,
    pub started_at_ms: i64,
    pub deadline_at_ms: i64,
    /// Monotonic dispatch allowance consumption. A reservation consumes one
    /// slot even when provider/session creation later fails, so clearing a
    /// package binding or retrying cannot reset the Run's cost envelope.
    #[serde(default)]
    pub work_sessions_started: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhaustion_started_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exhausted_at_ms: Option<i64>,
}

impl DcgRunBudget {
    fn from_policy(policy: DcgExecutionBudget, now_ms: i64) -> Self {
        // Validation caps this at 24 hours, so conversion is exact. Saturating
        // addition also keeps a corrupt legacy timestamp from panicking while
        // still failing closed at the platform clock boundary.
        let wall_clock_ms = policy.wall_clock_ms as i64;
        let deadline_at_ms = now_ms.saturating_add(wall_clock_ms);
        Self {
            wall_clock_ms: policy.wall_clock_ms,
            max_work_sessions: policy.max_work_sessions,
            max_concurrent_work_sessions: policy.max_concurrent_work_sessions,
            started_at_ms: now_ms,
            deadline_at_ms,
            work_sessions_started: 0,
            exhaustion_started_at_ms: None,
            exhausted_at_ms: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DcgRun {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub graph_version: Option<u32>,
    /// Immutable graph semantics selected by this Run. Project catalog updates
    /// affect new Runs only and cannot rewrite an in-flight Session.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub definition_snapshot: Option<DcgDefinition>,
    /// Immutable execution envelope copied from the selected Workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<DcgRunBudget>,
    pub status: DcgRunStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    pub active_nodes: BTreeSet<String>,
    #[serde(default)]
    pub node_instances: BTreeMap<String, DcgNodeInstance>,
    #[serde(default)]
    pub facts: BTreeSet<String>,
    /// Semantic outputs are scoped to the exact node attempt that produced
    /// them. They remain auditable after a transition but never satisfy a
    /// later retry instance by accident.
    #[serde(default)]
    pub instance_facts: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    pub history: Vec<DcgTransitionRecord>,
    pub traversals: BTreeMap<String, u32>,
    #[serde(default)]
    pub team_slots: BTreeMap<String, TeamSlot>,
    /// Durable interpreter diagnostic. Resource repair and other Sessions
    /// remain available while this Run waits for PM/user intervention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interpreter_error: Option<String>,
    pub revision: u64,
}

impl DcgRun {
    pub fn new_discussion(id: String, controller_session_id: String) -> Result<Self> {
        validate_id("DCG Run id", &id)?;
        if controller_session_id.trim().is_empty() {
            anyhow::bail!("DCG Run requires a controller Session");
        }
        Ok(Self {
            id,
            controller_session_id: Some(controller_session_id),
            graph_id: None,
            graph_version: None,
            definition_snapshot: None,
            budget: None,
            status: DcgRunStatus::Discussion,
            outcome: None,
            active_nodes: BTreeSet::new(),
            node_instances: BTreeMap::new(),
            facts: BTreeSet::new(),
            instance_facts: BTreeMap::new(),
            history: Vec::new(),
            traversals: BTreeMap::new(),
            team_slots: BTreeMap::new(),
            interpreter_error: None,
            revision: 1,
        })
    }

    pub fn select_before_start(&mut self, definition: &DcgDefinition) -> Result<()> {
        self.select_before_start_at(definition, chrono::Utc::now().timestamp_millis())
    }

    pub fn select_before_start_at(
        &mut self,
        definition: &DcgDefinition,
        now_ms: i64,
    ) -> Result<()> {
        if self.status != DcgRunStatus::Discussion
            || !self.traversals.is_empty()
            || !self.facts.is_empty()
            || !self.instance_facts.is_empty()
            || !self.history.is_empty()
            || !self.team_slots.is_empty()
        {
            anyhow::bail!("a started DCG Run requires an explicit graph migration");
        }
        if definition.kind != DcgKind::SessionWorkflow {
            anyhow::bail!("PM Session requires a sessionWorkflow graph");
        }
        self.graph_id = Some(definition.id.clone());
        self.graph_version = Some(definition.version);
        self.definition_snapshot = Some(definition.clone());
        self.budget = Some(DcgRunBudget::from_policy(
            definition.execution_budget,
            now_ms,
        ));
        self.active_nodes = BTreeSet::from([definition.entry.clone()]);
        self.node_instances.clear();
        self.outcome = None;
        let entry = definition.node(&definition.entry)?;
        let instance = DcgNodeInstance::active(
            &definition.entry,
            1,
            "root-1".into(),
            entry.fanout.as_ref().map(|fanout| fanout.source.clone()),
        );
        self.node_instances.insert(instance.id.clone(), instance);
        self.interpreter_error = None;
        self.status = DcgRunStatus::Active;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn budget_expired(&self, now_ms: i64) -> bool {
        self.status == DcgRunStatus::Active
            && self
                .budget
                .as_ref()
                .is_some_and(|budget| now_ms >= budget.deadline_at_ms)
    }

    pub fn backfill_execution_budget(
        &mut self,
        started_at_ms: i64,
        observed_work_sessions: u32,
    ) -> bool {
        if self.graph_id.is_none() || self.status == DcgRunStatus::Discussion {
            return false;
        }
        let mut changed = false;
        if self.budget.is_none() {
            let policy = self
                .definition_snapshot
                .as_ref()
                .map(|definition| definition.execution_budget)
                .unwrap_or_default();
            self.budget = Some(DcgRunBudget::from_policy(policy, started_at_ms));
            changed = true;
        }
        let budget = self.budget.as_mut().expect("selected Run has a budget");
        if budget.work_sessions_started < observed_work_sessions {
            budget.work_sessions_started = observed_work_sessions;
            changed = true;
        }
        changed
    }

    pub fn consume_work_session_dispatch(
        &mut self,
        now_ms: i64,
        observed_work_sessions: u32,
    ) -> Result<()> {
        if self.status != DcgRunStatus::Active {
            anyhow::bail!("Workflow Run is not active for WorkSession dispatch");
        }
        let budget = self
            .budget
            .as_mut()
            .ok_or_else(|| anyhow::anyhow!("Workflow Run has no execution budget"))?;
        if now_ms >= budget.deadline_at_ms {
            anyhow::bail!("Workflow Run wall-clock budget is exhausted");
        }
        budget.work_sessions_started = budget.work_sessions_started.max(observed_work_sessions);
        if budget.work_sessions_started >= budget.max_work_sessions {
            anyhow::bail!(
                "Workflow Run reached its maxWorkSessions budget ({})",
                budget.max_work_sessions
            );
        }
        budget.work_sessions_started = budget.work_sessions_started.saturating_add(1);
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn begin_budget_exhaustion(&mut self, now_ms: i64) -> bool {
        if self.status != DcgRunStatus::Active {
            return false;
        }
        self.status = DcgRunStatus::BudgetExhausting;
        self.interpreter_error = None;
        if let Some(budget) = self.budget.as_mut() {
            budget.exhaustion_started_at_ms = Some(now_ms);
        }
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn finish_budget_exhaustion(&mut self, now_ms: i64) -> bool {
        if self.status != DcgRunStatus::BudgetExhausting {
            return false;
        }
        self.status = DcgRunStatus::BudgetExhausted;
        self.outcome = Some("budget-exhausted".into());
        self.active_nodes.clear();
        if let Some(budget) = self.budget.as_mut() {
            budget.exhausted_at_ms = Some(now_ms);
        }
        self.revision = self.revision.saturating_add(1);
        true
    }

    pub fn is_terminal(&self) -> bool {
        matches!(
            self.status,
            DcgRunStatus::BudgetExhausted | DcgRunStatus::Completed | DcgRunStatus::Cancelled
        )
    }

    pub fn eligible_edges<'a>(
        &self,
        definition: &'a DcgDefinition,
        facts: &BTreeSet<String>,
    ) -> Result<Vec<&'a DcgEdge>> {
        self.ensure_definition(definition)?;
        if self.status != DcgRunStatus::Active {
            return Ok(Vec::new());
        }
        Ok(definition
            .edges
            .iter()
            .filter(|edge| {
                self.active_nodes.contains(&edge.from)
                    && edge.when.satisfied_by(facts)
                    && edge.max_traversals.is_none_or(|limit| {
                        self.traversals.get(&edge.id).copied().unwrap_or(0) < limit
                    })
            })
            .collect())
    }

    pub fn record_actor_facts(
        &mut self,
        definition: &DcgDefinition,
        node_id: &str,
        actor: DcgActor,
        facts: &BTreeSet<String>,
    ) -> Result<()> {
        self.ensure_definition(definition)?;
        let node = definition.node(node_id)?;
        let executor = node
            .executor
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("only activity nodes can record semantic outputs"))?;
        if executor.actor != actor || !matches!(actor, DcgActor::Pm | DcgActor::User) {
            anyhow::bail!("node {node_id} outputs cannot be asserted by {actor:?}");
        }
        let declared = node.outputs.iter().collect::<BTreeSet<_>>();
        if facts.is_empty() || facts.iter().any(|fact| !declared.contains(fact)) {
            anyhow::bail!("node {node_id} may record only its declared outputs");
        }
        let instance_id = self.active_node_instance(node_id)?.id.clone();
        self.instance_facts
            .entry(instance_id)
            .or_default()
            .extend(facts.iter().cloned());
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn set_current_facts(&mut self, facts: BTreeSet<String>) {
        if self.facts != facts {
            self.facts = facts;
            self.revision = self.revision.saturating_add(1);
        }
    }

    pub fn actor_facts_for_active_nodes(&self) -> BTreeSet<String> {
        self.node_instances
            .values()
            .filter(|instance| instance.status == DcgNodeInstanceStatus::Active)
            .filter_map(|instance| self.instance_facts.get(&instance.id))
            .flat_map(|facts| facts.iter().cloned())
            .collect()
    }

    pub fn transition(
        &mut self,
        definition: &DcgDefinition,
        edge_id: &str,
        facts: &BTreeSet<String>,
        chooser: DcgActor,
    ) -> Result<()> {
        self.transition_many(definition, &[edge_id], facts, chooser)
    }

    /// Atomically move one active node through one deterministic edge or an
    /// explicit fork. A fork is represented by several satisfied, non-choice
    /// edges with the same source and is never inferred from model text.
    pub fn transition_many(
        &mut self,
        definition: &DcgDefinition,
        edge_ids: &[&str],
        facts: &BTreeSet<String>,
        chooser: DcgActor,
    ) -> Result<()> {
        self.ensure_definition(definition)?;
        if matches!(
            self.status,
            DcgRunStatus::BudgetExhausting
                | DcgRunStatus::BudgetExhausted
                | DcgRunStatus::Completed
                | DcgRunStatus::Cancelled
        ) {
            anyhow::bail!("terminal DCG Run cannot transition");
        }
        if edge_ids.is_empty() {
            anyhow::bail!("a DCG transition requires at least one edge");
        }
        let edges = edge_ids
            .iter()
            .map(|id| definition.edge(id))
            .collect::<Result<Vec<_>>>()?;
        if edges
            .iter()
            .map(|edge| edge.id.as_str())
            .collect::<BTreeSet<_>>()
            .len()
            != edges.len()
        {
            anyhow::bail!("an atomic DCG transition cannot repeat an edge");
        }
        let source = edges[0].from.as_str();
        if edges.iter().any(|edge| edge.from != source) {
            anyhow::bail!("an atomic DCG fork must share one source node");
        }
        if !self.active_nodes.contains(source) {
            anyhow::bail!("DCG edge does not leave an active node");
        }
        let source_node = definition.node(source)?;
        if edges.len() > 1 && source_node.fork != Some(DcgForkMode::AllEligible) {
            anyhow::bail!(
                "node {source} has several eligible automatic edges but is not an explicit fork"
            );
        }
        let required_automatic_chooser = match source_node.kind {
            DcgNodeKind::Join => DcgActor::System,
            DcgNodeKind::Activity => match source_node
                .executor
                .as_ref()
                .expect("validated activity executor")
                .actor
            {
                DcgActor::Pm => DcgActor::Pm,
                DcgActor::User => DcgActor::User,
                DcgActor::WorkAgent | DcgActor::System => DcgActor::System,
            },
            DcgNodeKind::Terminal => anyhow::bail!("terminal nodes cannot transition"),
        };
        for edge in &edges {
            if !edge.when.satisfied_by(facts) {
                anyhow::bail!("edge {} condition is not satisfied", edge.id);
            }
            if chooser == DcgActor::User && edge.choose_by != Some(DcgActor::User) {
                anyhow::bail!("edge {} is not a user decision", edge.id);
            }
            if edge.choose_by.is_some_and(|required| required != chooser) {
                anyhow::bail!("edge {} must be chosen by {:?}", edge.id, edge.choose_by);
            }
            if edge.choose_by.is_none() && chooser != required_automatic_chooser {
                anyhow::bail!(
                    "edge {} must be advanced by {:?}",
                    edge.id,
                    required_automatic_chooser
                );
            }
            if edges.len() > 1 && edge.choose_by.is_some() {
                anyhow::bail!("decision edges cannot be taken as an automatic fork");
            }
            let count = self.traversals.get(&edge.id).copied().unwrap_or(0);
            if edge.max_traversals.is_some_and(|limit| count >= limit) {
                anyhow::bail!("edge {} reached maxTraversals", edge.id);
            }
        }
        let source_instance = self.active_node_instance(source)?.clone();
        let inherited_cohort = if source_instance.cohort_id.is_empty() {
            format!("legacy-{}", source_instance.id)
        } else {
            source_instance.cohort_id.clone()
        };
        let target_cohort = if edges.len() > 1 {
            format!("fork-{}-{}", source_instance.id, self.history.len() + 1)
        } else {
            inherited_cohort
        };
        self.active_nodes.remove(source);
        self.node_instances
            .get_mut(&source_instance.id)
            .expect("active source instance exists")
            .status = DcgNodeInstanceStatus::Completed;
        for edge in edges {
            self.activate_target(definition, edge, &source_instance, &target_cohort, facts)?;
            let count = self.traversals.get(&edge.id).copied().unwrap_or(0);
            self.history.push(DcgTransitionRecord {
                edge_id: edge.id.clone(),
                from: edge.from.clone(),
                to: edge.to.clone(),
                chooser,
                facts: facts.clone(),
                sequence: self.history.len().saturating_add(1) as u64,
            });
            self.traversals
                .insert(edge.id.clone(), count.saturating_add(1));
        }
        // Facts are attempt-local. The Coordinator immediately derives the
        // next active-node snapshot after this atomic move.
        self.facts.clear();
        self.refresh_status(definition)?;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    fn activate_target(
        &mut self,
        definition: &DcgDefinition,
        edge: &DcgEdge,
        source: &DcgNodeInstance,
        cohort_id: &str,
        facts: &BTreeSet<String>,
    ) -> Result<()> {
        let node = definition.node(&edge.to)?;
        if node.kind == DcgNodeKind::Join {
            let existing = self
                .node_instances
                .values()
                .find(|instance| instance.node_id == edge.to && instance.cohort_id == cohort_id)
                .map(|instance| instance.id.clone());
            let instance_id = match existing {
                Some(id) => id,
                None => {
                    if self.node_instances.values().any(|instance| {
                        instance.node_id == edge.to
                            && matches!(
                                instance.status,
                                DcgNodeInstanceStatus::Waiting | DcgNodeInstanceStatus::Active
                            )
                    }) {
                        anyhow::bail!("join node {} cannot mix concurrent fork cohorts", edge.to);
                    }
                    let iteration = self.next_iteration(&edge.to);
                    let instance =
                        DcgNodeInstance::waiting(&edge.to, iteration, cohort_id.to_string());
                    let id = instance.id.clone();
                    self.node_instances.insert(id.clone(), instance);
                    id
                }
            };
            let arrivals = {
                let instance = self
                    .node_instances
                    .get_mut(&instance_id)
                    .expect("join instance was created");
                instance.arrived_from.insert(edge.from.clone());
                instance.predecessor_instances.insert(source.id.clone());
                instance.activation_facts.extend(facts.iter().cloned());
                instance.arrived_from.len() as u32
            };
            if self
                .node_instances
                .get(&instance_id)
                .is_some_and(|instance| instance.status == DcgNodeInstanceStatus::Completed)
            {
                // `any` and `quorum` joins may already have advanced. Late
                // siblings are consumed by the same cohort instead of
                // creating a stranded second join token.
                return Ok(());
            }
            let incoming = definition
                .edges
                .iter()
                .filter(|candidate| candidate.to == edge.to)
                .map(|candidate| candidate.from.as_str())
                .collect::<BTreeSet<_>>()
                .len() as u32;
            let ready = match node.activation.as_ref().expect("validated join activation") {
                JoinActivation::Named(JoinActivationKind::All) => arrivals >= incoming,
                JoinActivation::Named(JoinActivationKind::Any) => arrivals >= 1,
                JoinActivation::Quorum { quorum } => arrivals >= *quorum,
            };
            if ready {
                self.node_instances
                    .get_mut(&instance_id)
                    .expect("join instance exists")
                    .status = DcgNodeInstanceStatus::Active;
                self.active_nodes.insert(edge.to.clone());
            }
            return Ok(());
        }

        if node.kind != DcgNodeKind::Terminal
            && self.node_instances.values().any(|instance| {
                instance.node_id == edge.to
                    && matches!(
                        instance.status,
                        DcgNodeInstanceStatus::Waiting | DcgNodeInstanceStatus::Active
                    )
            })
        {
            anyhow::bail!(
                "restricted Workflow cannot activate node {} twice concurrently",
                edge.to
            );
        }
        let iteration = self.next_iteration(&edge.to);
        let mut target = DcgNodeInstance::active(
            &edge.to,
            iteration,
            cohort_id.to_string(),
            node.fanout.as_ref().map(|fanout| fanout.source.clone()),
        );
        target.predecessor_instances.insert(source.id.clone());
        target.activation_facts.extend(facts.iter().cloned());
        if node.kind == DcgNodeKind::Terminal {
            target.status = DcgNodeInstanceStatus::Completed;
        } else {
            self.active_nodes.insert(edge.to.clone());
        }
        self.node_instances.insert(target.id.clone(), target);
        Ok(())
    }

    fn next_iteration(&self, node_id: &str) -> u32 {
        self.node_instances
            .values()
            .filter(|instance| instance.node_id == node_id)
            .map(|instance| instance.iteration)
            .max()
            .unwrap_or(0)
            .saturating_add(1)
    }

    fn refresh_status(&mut self, definition: &DcgDefinition) -> Result<()> {
        if matches!(
            self.status,
            DcgRunStatus::BudgetExhausting | DcgRunStatus::BudgetExhausted
        ) {
            return Ok(());
        }
        self.active_nodes = self
            .node_instances
            .values()
            .filter(|instance| instance.status == DcgNodeInstanceStatus::Active)
            .filter(|instance| {
                definition
                    .node(&instance.node_id)
                    .is_ok_and(|node| node.kind != DcgNodeKind::Terminal)
            })
            .map(|instance| instance.node_id.clone())
            .collect();
        let pending = self.node_instances.values().any(|instance| {
            matches!(
                instance.status,
                DcgNodeInstanceStatus::Active | DcgNodeInstanceStatus::Waiting
            )
        });
        let outcomes = self
            .node_instances
            .values()
            .filter(|instance| instance.status == DcgNodeInstanceStatus::Completed)
            .filter_map(|instance| definition.node(&instance.node_id).ok())
            .filter(|node| node.kind == DcgNodeKind::Terminal)
            .filter_map(|node| node.outcome.clone())
            .collect::<BTreeSet<_>>();
        if pending {
            self.outcome = None;
            self.status = DcgRunStatus::Active;
        } else {
            if outcomes.is_empty() {
                anyhow::bail!("DCG Run has no active work and reached no terminal outcome");
            }
            if outcomes.len() != 1 {
                anyhow::bail!(
                    "DCG Run reached conflicting terminal outcomes: {}",
                    outcomes.into_iter().collect::<Vec<_>>().join(", ")
                );
            }
            let outcome = outcomes.into_iter().next().expect("one outcome");
            self.status = if outcome == "cancelled" {
                DcgRunStatus::Cancelled
            } else {
                DcgRunStatus::Completed
            };
            self.outcome = Some(outcome);
        }
        Ok(())
    }

    pub fn active_node_instance(&self, node_id: &str) -> Result<&DcgNodeInstance> {
        self.node_instances
            .values()
            .find(|instance| {
                instance.node_id == node_id && instance.status == DcgNodeInstanceStatus::Active
            })
            .ok_or_else(|| anyhow::anyhow!("node {node_id} has no active instance in this Run"))
    }

    pub fn seal_fanout(&mut self, node_instance_id: &str) -> Result<()> {
        let instance = self
            .node_instances
            .get_mut(node_instance_id)
            .ok_or_else(|| anyhow::anyhow!("unknown workflow node instance"))?;
        // The cohort is sealed exactly once when its first package leaves
        // Planned. Packages deliberately keep progressing through review
        // after their source node advances, so later package transitions must
        // treat the already-sealed completed instance as idempotent.
        if instance.fanout_sealed {
            return Ok(());
        }
        if instance.status != DcgNodeInstanceStatus::Active {
            anyhow::bail!("only an active workAgent node can seal its WorkPackage fanout");
        }
        instance.fanout_sealed = true;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    /// Reopens a cohort only when the PM withdraws a package before any work
    /// in that cohort has started. The package and Team Slot remain durable
    /// history; reopening merely allows a replacement identity to consume the
    /// vacated fanout capacity.
    pub fn reopen_fanout_for_withdrawal(&mut self, node_instance_id: &str) -> Result<()> {
        let instance = self
            .node_instances
            .get_mut(node_instance_id)
            .ok_or_else(|| anyhow::anyhow!("unknown workflow node instance"))?;
        if instance.status != DcgNodeInstanceStatus::Active {
            anyhow::bail!("only an active workAgent node can replace a withdrawn WorkPackage");
        }
        if !instance.fanout_sealed {
            return Ok(());
        }
        instance.fanout_sealed = false;
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn active_ancestor_instances(&self, node_id: &str) -> Result<BTreeSet<String>> {
        let active = self.active_node_instance(node_id)?;
        let mut pending = active
            .predecessor_instances
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        let mut ancestors = BTreeSet::new();
        while let Some(id) = pending.pop() {
            if !ancestors.insert(id.clone()) {
                continue;
            }
            let instance = self
                .node_instances
                .get(&id)
                .ok_or_else(|| anyhow::anyhow!("workflow predecessor instance is missing"))?;
            pending.extend(instance.predecessor_instances.iter().cloned());
        }
        Ok(ancestors)
    }

    pub fn bind_team_slot(&mut self, slot: TeamSlot) -> Result<()> {
        slot.validate()?;
        let instance = self
            .node_instances
            .get(&slot.node_instance_id)
            .ok_or_else(|| anyhow::anyhow!("Team Slot names an unknown node instance"))?;
        if instance.status != DcgNodeInstanceStatus::Active {
            anyhow::bail!("Team Slot requires an active node instance");
        }
        if self.team_slots.values().any(|existing| {
            existing.work_package_id == slot.work_package_id && existing.id != slot.id
        }) {
            anyhow::bail!("a WorkPackage cannot belong to two Team Slots");
        }
        self.team_slots.insert(slot.id.clone(), slot);
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    fn ensure_definition(&self, definition: &DcgDefinition) -> Result<()> {
        if self.graph_id.as_deref() != Some(definition.id.as_str())
            || self.graph_version != Some(definition.version)
        {
            anyhow::bail!("DCG Run is pinned to another graph version");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgNodeInstanceStatus {
    Active,
    Waiting,
    Completed,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgNodeInstance {
    pub id: String,
    pub node_id: String,
    pub iteration: u32,
    pub status: DcgNodeInstanceStatus,
    /// One bounded fork cohort. Different cohorts may never occupy the same
    /// non-join node concurrently, avoiding a general token algebra.
    #[serde(default)]
    pub cohort_id: String,
    #[serde(default)]
    pub arrived_from: BTreeSet<String>,
    #[serde(default)]
    pub predecessor_instances: BTreeSet<String>,
    #[serde(default)]
    pub activation_facts: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fanout_source: Option<String>,
    #[serde(default)]
    pub fanout_sealed: bool,
}

impl DcgNodeInstance {
    fn active(
        node_id: &str,
        iteration: u32,
        cohort_id: String,
        fanout_source: Option<String>,
    ) -> Self {
        Self {
            id: format!("{node_id}-{iteration}"),
            node_id: node_id.to_string(),
            iteration,
            status: DcgNodeInstanceStatus::Active,
            cohort_id,
            arrived_from: BTreeSet::new(),
            predecessor_instances: BTreeSet::new(),
            activation_facts: BTreeSet::new(),
            fanout_source,
            fanout_sealed: false,
        }
    }

    fn waiting(node_id: &str, iteration: u32, cohort_id: String) -> Self {
        Self {
            id: format!("{node_id}-{iteration}"),
            node_id: node_id.to_string(),
            iteration,
            status: DcgNodeInstanceStatus::Waiting,
            cohort_id,
            arrived_from: BTreeSet::new(),
            predecessor_instances: BTreeSet::new(),
            activation_facts: BTreeSet::new(),
            fanout_source: None,
            fanout_sealed: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DcgTransitionRecord {
    pub edge_id: String,
    pub from: String,
    pub to: String,
    pub chooser: DcgActor,
    pub facts: BTreeSet<String>,
    pub sequence: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TeamSlotStatus {
    Planned,
    Preparing,
    Working,
    Waiting,
    Returning,
    Completed,
    Blocked,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamSlot {
    pub id: String,
    pub node_instance_id: String,
    pub work_package_id: String,
    pub responsibility: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub space_lease_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_work_session_id: Option<String>,
    pub status: TeamSlotStatus,
}

impl TeamSlot {
    pub fn validate(&self) -> Result<()> {
        validate_id("Team Slot id", &self.id)?;
        validate_id("Team Slot node instance", &self.node_instance_id)?;
        validate_id("Team Slot work package", &self.work_package_id)?;
        if self.responsibility.trim().is_empty()
            || self.responsibility.len() > 500
            || self.responsibility.chars().any(char::is_control)
        {
            anyhow::bail!("Team Slot responsibility must be 1-500 printable characters");
        }
        Ok(())
    }
}

fn validate_conditions(label: &str, conditions: &[DcgCondition]) -> Result<()> {
    if conditions.is_empty() || conditions.len() > 64 {
        anyhow::bail!("condition {label} must contain 1-64 items");
    }
    for condition in conditions {
        condition.validate()?;
    }
    Ok(())
}

fn validate_fact(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || value.chars().any(char::is_control)
        || !value
            .chars()
            .all(|character| character.is_alphanumeric() || matches!(character, '.' | '-' | '_'))
    {
        anyhow::bail!("{label} must be a 1-200 character structured fact path");
    }
    Ok(())
}

fn validate_id(label: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 80
        || !value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'-' | b'_'))
        })
    {
        anyhow::bail!("{label} must use lowercase letters, digits, '-' or '_'");
    }
    Ok(())
}

fn unique_ids(label: &str, values: &[String]) -> Result<()> {
    let mut unique = BTreeSet::new();
    for value in values {
        validate_fact(label, value)?;
        if !unique.insert(value) {
            anyhow::bail!("duplicate {label}: {value}");
        }
    }
    Ok(())
}

fn resolve_resource(root: &Path, relative: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        anyhow::bail!("workflow resource path escaped its Skill: {relative}");
    }
    let candidate = root.join(path);
    let parent = candidate
        .parent()
        .ok_or_else(|| anyhow::anyhow!("workflow resource has no parent"))?;
    let parent = parent
        .canonicalize()
        .with_context(|| format!("workflow resource parent is unavailable: {relative}"))?;
    if !parent.starts_with(root) {
        anyhow::bail!("workflow resource path escaped its Skill: {relative}");
    }
    Ok(parent.join(
        candidate
            .file_name()
            .ok_or_else(|| anyhow::anyhow!("workflow resource has no file name"))?,
    ))
}

fn reachable_nodes(entry: &str, edges: &[DcgEdge]) -> BTreeSet<String> {
    let mut reachable = BTreeSet::from([entry.to_string()]);
    loop {
        let before = reachable.len();
        for edge in edges {
            if reachable.contains(&edge.from) {
                reachable.insert(edge.to.clone());
            }
        }
        if reachable.len() == before {
            return reachable;
        }
    }
}

fn can_reach_any(entry: &str, targets: &BTreeSet<String>, edges: &[DcgEdge]) -> bool {
    reachable_nodes(entry, edges)
        .iter()
        .any(|node| targets.contains(node))
}

fn nodes_that_can_reach_any(targets: &BTreeSet<String>, edges: &[DcgEdge]) -> BTreeSet<String> {
    let mut reachable = targets.clone();
    loop {
        let before = reachable.len();
        for edge in edges {
            if reachable.contains(&edge.to) {
                reachable.insert(edge.from.clone());
            }
        }
        if reachable.len() == before {
            return reachable;
        }
    }
}

fn node_is_in_cycle(node: &str, edges: &[DcgEdge]) -> bool {
    edges
        .iter()
        .filter(|edge| edge.from == node)
        .any(|edge| edge.to == node || reachable_nodes(&edge.to, edges).contains(node))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_space_builder::{render_pm_space, PmSpaceTemplateValues};

    fn catalog_fixture() -> (tempfile::TempDir, DcgCatalog) {
        let temporary = tempfile::tempdir().unwrap();
        let project = temporary.path().join("project");
        std::fs::create_dir_all(&project).unwrap();
        render_pm_space(
            &project,
            &PmSpaceTemplateValues::new("测试项目", "zh-CN", "feature").unwrap(),
        )
        .unwrap();
        let catalog = DcgCatalog::load(&project.join("spaces/pm/skills/project-workflow")).unwrap();
        (temporary, catalog)
    }

    #[test]
    fn built_in_template_has_one_workflow_dcg_layer_and_multiple_graphs() {
        let (_temporary, catalog) = catalog_fixture();
        assert_eq!(catalog.recommended_session_workflow, "feature");
        assert_eq!(
            catalog
                .session_workflows
                .keys()
                .cloned()
                .collect::<Vec<_>>(),
            vec!["bugfix", "feature", "migration"]
        );
    }

    #[test]
    fn a_session_run_selects_before_start_and_only_takes_eligible_edges() {
        let (_temporary, catalog) = catalog_fixture();
        let bugfix = catalog.session_workflow("bugfix").unwrap();
        let mut run = DcgRun::new_discussion("run-1".into(), "s_pm".into()).unwrap();
        assert_eq!(run.graph_id, None);
        assert!(run.active_nodes.is_empty());
        run.select_before_start(bugfix).unwrap();
        assert_eq!(run.graph_id.as_deref(), Some("bugfix"));
        assert_eq!(run.active_nodes, BTreeSet::from(["fix".into()]));

        let facts = BTreeSet::from(["work.candidate".into()]);
        assert_eq!(run.eligible_edges(bugfix, &facts).unwrap()[0].id, "fixed");
        let error = run
            .transition(bugfix, "fixed", &facts, DcgActor::User)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a user decision"), "{error}");
        run.transition(bugfix, "fixed", &facts, DcgActor::System)
            .unwrap();
        assert_eq!(run.active_nodes, BTreeSet::from(["review".into()]));
        assert!(run
            .select_before_start(catalog.session_workflow("feature").unwrap())
            .is_err());
    }

    #[test]
    fn selected_run_pins_a_deterministic_ten_minute_execution_budget() {
        let (_temporary, catalog) = catalog_fixture();
        let feature = catalog.session_workflow("feature").unwrap();
        assert_eq!(feature.execution_budget.wall_clock_ms, 600_000);
        assert_eq!(feature.execution_budget.max_work_sessions, 16);
        assert_eq!(feature.execution_budget.max_concurrent_work_sessions, 4);

        let mut run = DcgRun::new_discussion("run-budget".into(), "s_pm".into()).unwrap();
        run.select_before_start_at(feature, 1_000).unwrap();
        let budget = run.budget.as_ref().expect("selected Run pins its budget");
        assert_eq!(budget.started_at_ms, 1_000);
        assert_eq!(budget.deadline_at_ms, 601_000);
        assert_eq!(budget.work_sessions_started, 0);
        assert!(!run.budget_expired(600_999));
        run.consume_work_session_dispatch(600_999, 0).unwrap();
        assert_eq!(run.budget.as_ref().unwrap().work_sessions_started, 1);
        assert!(run.budget_expired(601_000));

        assert!(run.begin_budget_exhaustion(601_000));
        assert_eq!(run.status, DcgRunStatus::BudgetExhausting);
        assert!(run
            .eligible_edges(feature, &BTreeSet::new())
            .unwrap()
            .is_empty());
        assert!(run.finish_budget_exhaustion(601_001));
        assert_eq!(run.status, DcgRunStatus::BudgetExhausted);
        assert_eq!(run.outcome.as_deref(), Some("budget-exhausted"));
        assert!(run.active_nodes.is_empty());

        let mut invalid = feature.clone();
        invalid.execution_budget.max_concurrent_work_sessions =
            invalid.execution_budget.max_work_sessions + 1;
        assert!(invalid.validate(&catalog.root).is_err());

        let mut legacy = DcgRun::new_discussion("run-legacy".into(), "s_legacy".into()).unwrap();
        legacy.select_before_start_at(feature, 10).unwrap();
        legacy.budget = None;
        assert!(legacy.backfill_execution_budget(20, 3));
        let migrated = legacy.budget.as_ref().unwrap();
        assert_eq!(migrated.started_at_ms, 20);
        assert_eq!(migrated.deadline_at_ms, 600_020);
        assert_eq!(migrated.work_sessions_started, 3);
        assert!(!legacy.backfill_execution_budget(30, 2));
    }

    #[test]
    fn cyclic_edges_are_bounded_and_pm_choice_is_enforced() {
        let (_temporary, catalog) = catalog_fixture();
        let feature = catalog.session_workflow("feature").unwrap();
        let mut run = DcgRun::new_discussion("run-1".into(), "s_pm".into()).unwrap();
        run.select_before_start(feature).unwrap();
        run.active_nodes = BTreeSet::from(["recover".into()]);
        run.node_instances.clear();
        let recover = DcgNodeInstance::active("recover", 1, "root-1".into(), None);
        run.node_instances.insert(recover.id.clone(), recover);
        run.status = DcgRunStatus::Active;
        let facts = BTreeSet::from(["decision.ready".into()]);
        assert!(run
            .transition(feature, "retry", &facts, DcgActor::Pm)
            .is_err());
        run.transition(feature, "retry", &facts, DcgActor::User)
            .unwrap();
        for instance in run.node_instances.values_mut() {
            if instance.status == DcgNodeInstanceStatus::Active {
                instance.status = DcgNodeInstanceStatus::Completed;
            }
        }
        run.active_nodes = BTreeSet::from(["recover".into()]);
        let recover = DcgNodeInstance::active("recover", 2, "root-1".into(), None);
        run.node_instances.insert(recover.id.clone(), recover);
        run.transition(feature, "retry", &facts, DcgActor::User)
            .unwrap();
        for instance in run.node_instances.values_mut() {
            if instance.status == DcgNodeInstanceStatus::Active {
                instance.status = DcgNodeInstanceStatus::Completed;
            }
        }
        run.active_nodes = BTreeSet::from(["recover".into()]);
        let recover = DcgNodeInstance::active("recover", 3, "root-1".into(), None);
        run.node_instances.insert(recover.id.clone(), recover);
        assert!(run
            .transition(feature, "retry", &facts, DcgActor::User)
            .is_err());
    }

    #[test]
    fn unbounded_back_edge_is_rejected() {
        let (_temporary, catalog) = catalog_fixture();
        let mut graph = catalog.session_workflow("feature").unwrap().clone();
        let edge = graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "retry")
            .unwrap();
        edge.max_traversals = None;
        let error = graph.validate(&catalog.root).unwrap_err().to_string();
        assert!(error.contains("maxTraversals"));
    }

    #[test]
    fn closed_autonomous_cycle_is_rejected_even_when_another_branch_terminates() {
        let graph: DcgDefinition = serde_yaml::from_str(
            r#"
schema: genehub-pm-dcg.v1
id: closed-loop
kind: sessionWorkflow
version: 1
entry: choose
nodes:
  - { id: choose, kind: activity, executor: { actor: system } }
  - { id: delivered, kind: terminal, outcome: delivered }
  - { id: spin-a, kind: activity, executor: { actor: system } }
  - { id: spin-b, kind: activity, executor: { actor: system } }
edges:
  - { id: finish, from: choose, to: delivered, when: route.finish }
  - { id: enter-loop, from: choose, to: spin-a, when: route.loop }
  - { id: spin-forward, from: spin-a, to: spin-b, when: spin.forward }
  - { id: spin-again, from: spin-b, to: spin-a, when: spin.again, maxTraversals: 2 }
"#,
        )
        .unwrap();

        let error = graph.validate(Path::new(".")).unwrap_err().to_string();
        assert!(error.contains("closed autonomous cycle"), "{error}");
        assert!(
            error.contains("spin-a") && error.contains("spin-b"),
            "{error}"
        );
    }

    #[test]
    fn explicit_fork_and_all_join_complete_one_bounded_cohort() {
        let graph: DcgDefinition = serde_yaml::from_str(
            r#"
schema: genehub-pm-dcg.v1
id: all-join
kind: sessionWorkflow
version: 1
entry: split
nodes:
  - { id: split, kind: activity, executor: { actor: system }, fork: allEligible }
  - { id: left, kind: activity, executor: { actor: system } }
  - { id: right, kind: activity, executor: { actor: system } }
  - { id: merge, kind: join, activation: all }
  - { id: delivered, kind: terminal, outcome: delivered }
edges:
  - { id: split-left, from: split, to: left, when: split.ready }
  - { id: split-right, from: split, to: right, when: split.ready }
  - { id: left-done, from: left, to: merge, when: branch.done }
  - { id: right-done, from: right, to: merge, when: branch.done }
  - { id: merged, from: merge, to: delivered, when: join.ready }
"#,
        )
        .unwrap();
        graph.validate(Path::new(".")).unwrap();
        let mut run = DcgRun::new_discussion("run-join".into(), "s_pm".into()).unwrap();
        run.select_before_start(&graph).unwrap();
        let split = BTreeSet::from(["split.ready".into()]);
        run.transition_many(
            &graph,
            &["split-left", "split-right"],
            &split,
            DcgActor::System,
        )
        .unwrap();
        assert_eq!(
            run.active_nodes,
            BTreeSet::from(["left".into(), "right".into()])
        );

        let branch = BTreeSet::from(["branch.done".into()]);
        run.transition(&graph, "left-done", &branch, DcgActor::System)
            .unwrap();
        assert_eq!(run.active_nodes, BTreeSet::from(["right".into()]));
        run.transition(&graph, "right-done", &branch, DcgActor::System)
            .unwrap();
        assert_eq!(run.active_nodes, BTreeSet::from(["merge".into()]));
        run.transition(
            &graph,
            "merged",
            &BTreeSet::from(["join.ready".into()]),
            DcgActor::System,
        )
        .unwrap();
        assert_eq!(run.status, DcgRunStatus::Completed);
        assert_eq!(run.outcome.as_deref(), Some("delivered"));
    }

    #[test]
    fn quorum_join_consumes_late_siblings_before_run_completion() {
        let graph: DcgDefinition = serde_yaml::from_str(
            r#"
schema: genehub-pm-dcg.v1
id: quorum-join
kind: sessionWorkflow
version: 1
entry: split
nodes:
  - { id: split, kind: activity, executor: { actor: system }, fork: allEligible }
  - { id: left, kind: activity, executor: { actor: system } }
  - { id: middle, kind: activity, executor: { actor: system } }
  - { id: right, kind: activity, executor: { actor: system } }
  - { id: merge, kind: join, activation: { quorum: 2 } }
  - { id: delivered, kind: terminal, outcome: delivered }
edges:
  - { id: split-left, from: split, to: left, when: split.ready }
  - { id: split-middle, from: split, to: middle, when: split.ready }
  - { id: split-right, from: split, to: right, when: split.ready }
  - { id: left-done, from: left, to: merge, when: branch.done }
  - { id: middle-done, from: middle, to: merge, when: branch.done }
  - { id: right-done, from: right, to: merge, when: branch.done }
  - { id: merged, from: merge, to: delivered, when: join.ready }
"#,
        )
        .unwrap();
        graph.validate(Path::new(".")).unwrap();
        let mut run = DcgRun::new_discussion("run-quorum".into(), "s_pm".into()).unwrap();
        run.select_before_start(&graph).unwrap();
        run.transition_many(
            &graph,
            &["split-left", "split-middle", "split-right"],
            &BTreeSet::from(["split.ready".into()]),
            DcgActor::System,
        )
        .unwrap();
        let branch = BTreeSet::from(["branch.done".into()]);
        run.transition(&graph, "left-done", &branch, DcgActor::System)
            .unwrap();
        run.transition(&graph, "middle-done", &branch, DcgActor::System)
            .unwrap();
        run.transition(
            &graph,
            "merged",
            &BTreeSet::from(["join.ready".into()]),
            DcgActor::System,
        )
        .unwrap();
        assert_eq!(run.status, DcgRunStatus::Active);
        assert_eq!(run.active_nodes, BTreeSet::from(["right".into()]));

        run.transition(&graph, "right-done", &branch, DcgActor::System)
            .unwrap();
        assert_eq!(run.status, DcgRunStatus::Completed);
        assert_eq!(
            run.node_instances
                .values()
                .filter(|instance| instance.node_id == "merge")
                .count(),
            1
        );
    }

    #[test]
    fn bounded_cycles_with_user_supervision_are_allowed() {
        let mut graph: DcgDefinition = serde_yaml::from_str(
            r#"
schema: genehub-pm-dcg.v1
id: supervised-loop
kind: sessionWorkflow
version: 1
entry: choose
nodes:
  - { id: choose, kind: activity, executor: { actor: system } }
  - { id: delivered, kind: terminal, outcome: delivered }
  - { id: wait-user, kind: activity, executor: { actor: system } }
  - { id: retry, kind: activity, executor: { actor: system } }
edges:
  - { id: finish, from: choose, to: delivered, when: route.finish }
  - { id: enter-loop, from: choose, to: wait-user, when: route.loop }
  - { id: user-retry, from: wait-user, to: retry, when: user.retry, chooseBy: user }
  - { id: retry-again, from: retry, to: wait-user, when: retry.failed, maxTraversals: 2 }
"#,
        )
        .unwrap();

        graph.validate(Path::new(".")).unwrap();

        graph
            .nodes
            .iter_mut()
            .find(|node| node.id == "wait-user")
            .and_then(|node| node.executor.as_mut())
            .unwrap()
            .actor = DcgActor::User;
        graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "user-retry")
            .unwrap()
            .choose_by = None;
        graph.validate(Path::new(".")).unwrap();
    }
}
