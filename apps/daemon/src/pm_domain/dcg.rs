use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const DCG_SCHEMA: &str = "genehub-pm-dcg.v1";
pub const DCG_CATALOG_SCHEMA: &str = "genehub-pm-dcg-catalog.v1";

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
    pub nodes: Vec<DcgNode>,
    pub edges: Vec<DcgEdge>,
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
        match self.kind {
            DcgNodeKind::Activity => {
                let executor = self.executor.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("activity node {} requires an executor", self.id)
                })?;
                executor.validate()?;
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
                    || self.outcome.is_some()
                {
                    anyhow::bail!("join node {} has activity/terminal-only fields", self.id);
                }
            }
            DcgNodeKind::Terminal => {
                if self.outcome.as_deref().is_none_or(str::is_empty) {
                    anyhow::bail!("terminal node {} requires outcome", self.id);
                }
                if self.executor.is_some()
                    || self.objective.is_some()
                    || self.fanout.is_some()
                    || self.activation.is_some()
                {
                    anyhow::bail!("terminal node {} has activity/join-only fields", self.id);
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
    pub foreach: String,
    pub max_items: u32,
}

impl DcgFanout {
    fn validate(&self) -> Result<()> {
        validate_fact("fanout.foreach", &self.foreach)?;
        if self.max_items == 0 || self.max_items > 32 {
            anyhow::bail!("fanout.maxItems must be 1-32");
        }
        Ok(())
    }
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DcgRunStatus {
    Discussion,
    Active,
    Completed,
    Cancelled,
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
    pub status: DcgRunStatus,
    pub active_nodes: BTreeSet<String>,
    #[serde(default)]
    pub node_instances: BTreeMap<String, DcgNodeInstance>,
    #[serde(default)]
    pub facts: BTreeSet<String>,
    #[serde(default)]
    pub history: Vec<DcgTransitionRecord>,
    pub traversals: BTreeMap<String, u32>,
    #[serde(default)]
    pub team_slots: BTreeMap<String, TeamSlot>,
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
            status: DcgRunStatus::Discussion,
            active_nodes: BTreeSet::new(),
            node_instances: BTreeMap::new(),
            facts: BTreeSet::new(),
            history: Vec::new(),
            traversals: BTreeMap::new(),
            team_slots: BTreeMap::new(),
            revision: 1,
        })
    }

    pub fn select_before_start(&mut self, definition: &DcgDefinition) -> Result<()> {
        if self.status != DcgRunStatus::Discussion
            || !self.traversals.is_empty()
            || !self.facts.is_empty()
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
        self.active_nodes = BTreeSet::from([definition.entry.clone()]);
        self.node_instances.clear();
        let instance = DcgNodeInstance::active(&definition.entry, 1);
        self.node_instances.insert(instance.id.clone(), instance);
        self.revision = self.revision.saturating_add(1);
        Ok(())
    }

    pub fn eligible_edges<'a>(
        &self,
        definition: &'a DcgDefinition,
        facts: &BTreeSet<String>,
    ) -> Result<Vec<&'a DcgEdge>> {
        self.ensure_definition(definition)?;
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

    pub fn transition(
        &mut self,
        definition: &DcgDefinition,
        edge_id: &str,
        facts: &BTreeSet<String>,
        chooser: DcgActor,
    ) -> Result<()> {
        self.ensure_definition(definition)?;
        if matches!(
            self.status,
            DcgRunStatus::Completed | DcgRunStatus::Cancelled
        ) {
            anyhow::bail!("terminal DCG Run cannot transition");
        }
        let edge = definition.edge(edge_id)?;
        if !self.active_nodes.contains(&edge.from) {
            anyhow::bail!("edge {edge_id} does not leave an active node");
        }
        if !edge.when.satisfied_by(facts) {
            anyhow::bail!("edge {edge_id} condition is not satisfied");
        }
        if chooser == DcgActor::User && edge.choose_by != Some(DcgActor::User) {
            anyhow::bail!("edge {edge_id} is not a user decision");
        }
        if edge.choose_by.is_some_and(|required| required != chooser) {
            anyhow::bail!("edge {edge_id} must be chosen by {:?}", edge.choose_by);
        }
        let count = self.traversals.get(edge_id).copied().unwrap_or(0);
        if edge.max_traversals.is_some_and(|limit| count >= limit) {
            anyhow::bail!("edge {edge_id} reached maxTraversals");
        }
        self.active_nodes.remove(&edge.from);
        self.active_nodes.insert(edge.to.clone());
        for instance in self
            .node_instances
            .values_mut()
            .filter(|instance| instance.node_id == edge.from && instance.status == DcgNodeInstanceStatus::Active)
        {
            instance.status = DcgNodeInstanceStatus::Completed;
        }
        let target_iteration = self
            .node_instances
            .values()
            .filter(|instance| instance.node_id == edge.to)
            .count()
            .saturating_add(1) as u32;
        let target = DcgNodeInstance::active(&edge.to, target_iteration);
        self.node_instances.insert(target.id.clone(), target);
        self.facts.extend(facts.iter().cloned());
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
        self.status = if definition.node(&edge.to)?.kind == DcgNodeKind::Terminal {
            DcgRunStatus::Completed
        } else {
            DcgRunStatus::Active
        };
        self.revision = self.revision.saturating_add(1);
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

    pub fn bind_team_slot(&mut self, slot: TeamSlot) -> Result<()> {
        slot.validate()?;
        let instance = self
            .node_instances
            .get(&slot.node_instance_id)
            .ok_or_else(|| anyhow::anyhow!("Team Slot names an unknown node instance"))?;
        if instance.status != DcgNodeInstanceStatus::Active {
            anyhow::bail!("Team Slot requires an active node instance");
        }
        if self
            .team_slots
            .values()
            .any(|existing| existing.work_package_id == slot.work_package_id && existing.id != slot.id)
        {
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
}

impl DcgNodeInstance {
    fn active(node_id: &str, iteration: u32) -> Self {
        Self {
            id: format!("{node_id}-{iteration}"),
            node_id: node_id.to_string(),
            iteration,
            status: DcgNodeInstanceStatus::Active,
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
        assert_eq!(run.active_nodes, BTreeSet::from(["reproduce".into()]));

        let facts = BTreeSet::from(["diagnosis.rootCause.verified".into()]);
        assert_eq!(
            run.eligible_edges(bugfix, &facts).unwrap()[0].id,
            "diagnosed"
        );
        let error = run
            .transition(bugfix, "diagnosed", &facts, DcgActor::User)
            .unwrap_err()
            .to_string();
        assert!(error.contains("not a user decision"), "{error}");
        run.transition(bugfix, "diagnosed", &facts, DcgActor::System)
            .unwrap();
        assert_eq!(run.active_nodes, BTreeSet::from(["fix".into()]));
        assert!(run
            .select_before_start(catalog.session_workflow("feature").unwrap())
            .is_err());
    }

    #[test]
    fn cyclic_edges_are_bounded_and_pm_choice_is_enforced() {
        let (_temporary, catalog) = catalog_fixture();
        let feature = catalog.session_workflow("feature").unwrap();
        let mut run = DcgRun::new_discussion("run-1".into(), "s_pm".into()).unwrap();
        run.select_before_start(feature).unwrap();
        run.active_nodes = BTreeSet::from(["review".into()]);
        run.status = DcgRunStatus::Active;
        let facts = BTreeSet::from(["review.verdict.fail".into()]);
        assert!(run
            .transition(feature, "rework", &facts, DcgActor::System)
            .is_err());
        run.transition(feature, "rework", &facts, DcgActor::Pm)
            .unwrap();
        run.active_nodes = BTreeSet::from(["review".into()]);
        run.transition(feature, "rework", &facts, DcgActor::Pm)
            .unwrap();
        run.active_nodes = BTreeSet::from(["review".into()]);
        assert!(run
            .transition(feature, "rework", &facts, DcgActor::Pm)
            .is_err());
    }

    #[test]
    fn unbounded_back_edge_is_rejected() {
        let (_temporary, catalog) = catalog_fixture();
        let mut graph = catalog.session_workflow("feature").unwrap().clone();
        let edge = graph
            .edges
            .iter_mut()
            .find(|edge| edge.id == "rework")
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
