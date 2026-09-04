//! AgentSpace composition: which responsibilities a Space carries, where it
//! sits in the ownership tree, and who may schedule whom.
//!
//! An AgentSpace is a container. `pm`, `executor`, `worker` and `reviewer` are
//! components mounted on it, not mutually exclusive Space kinds, so one Space
//! can manage a project and drive a flow, or execute a node and own a subteam.
//!
//! Two boundaries are load bearing and are enforced here rather than left to
//! callers:
//!
//! * **Parent answers ownership; the executor component answers scheduling.**
//!   They share one tree but are not the same question, so a plain parent
//!   never acquires the right to dispatch.
//! * **A component identifier is not authority.** It selects a versioned
//!   contract. Effective capability stays the intersection of the
//!   authenticated caller, the project scope and the task.

use anyhow::{bail, Result};
use genehub_proto::{AgentComponentInfo, AgentSpaceInfo, AgentSpaceOperation, PipeSpaceInfo};

use crate::config::{AgentComponentEntry, AgentSpaceEntry};

pub const COMPONENT_PM: &str = "pm";
pub const COMPONENT_EXECUTOR: &str = "executor";
pub const COMPONENT_WORKER: &str = "worker";
pub const COMPONENT_REVIEWER: &str = "reviewer";

/// Every component the first batch defines a contract for. Unknown ids are
/// refused rather than stored, so a typo cannot become a durable relationship
/// that nothing will ever schedule.
pub const COMPONENT_IDS: [&str; 4] = [
    COMPONENT_PM,
    COMPONENT_EXECUTOR,
    COMPONENT_WORKER,
    COMPONENT_REVIEWER,
];

/// Bumped only when an older daemon would *misread* a stored component, in
/// the same spirit as the session storage format: adding an optional field is
/// not a reason to lock anybody out of their own project tree.
pub const COMPONENT_SCHEMA_VERSION: u32 = 1;

/// The single `workerRole` value the exclusive model used for the reusable
/// flow carrier. It is now the `executor` component, and this constant exists
/// only for the migration and the compatibility projection.
pub const LEGACY_EXECUTOR_ROLE: &str = "workflow-executor";

pub const LIFECYCLES: [&str; 3] = ["persistent", "pooled", "ephemeral"];

/// Depth guard for tree walks. A registry deep enough to hit this is already
/// malformed, and refusing is better than recursing on it.
const MAX_TREE_DEPTH: usize = 64;

pub fn valid_lifecycle(lifecycle: &str) -> bool {
    LIFECYCLES.contains(&lifecycle)
}

/// Stable lowercase identifier, the same shape the exclusive model required
/// of `workerRole`.
pub fn valid_role(role: &str) -> bool {
    !role.is_empty()
        && role.len() <= 64
        && role.starts_with(|ch: char| ch.is_ascii_lowercase())
        && role
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

pub fn enabled_component<'a>(
    entry: &'a AgentSpaceEntry,
    component_id: &str,
) -> Option<&'a AgentComponentEntry> {
    entry
        .components
        .iter()
        .find(|component| component.component_id == component_id && component.enabled)
}

pub fn has_enabled_component(entry: &AgentSpaceEntry, component_id: &str) -> bool {
    enabled_component(entry, component_id).is_some()
}

/// Applies one operation to the registration a caller just read.
///
/// Pure: it validates the component contract and produces the next entry
/// without touching the tree, the filesystem or the revision. Tree-wide rules
/// need the whole registry and live in [`check_tree`]; the caller owns the
/// PipeBuilder lock digest and the revision bump.
pub fn apply(
    current: &AgentSpaceEntry,
    operation: &AgentSpaceOperation,
) -> Result<AgentSpaceEntry> {
    let mut next = current.clone();
    match operation {
        AgentSpaceOperation::SetComponent {
            component_id,
            enabled,
            role,
        } => {
            let component_id = component_id.trim();
            if !COMPONENT_IDS.contains(&component_id) {
                bail!(
                    "unknown component: {component_id}; expected one of {}",
                    COMPONENT_IDS.join(", ")
                );
            }
            let role = role
                .as_deref()
                .map(str::trim)
                .filter(|role| !role.is_empty());
            if component_id == COMPONENT_WORKER {
                let Some(role) = role else {
                    bail!("the worker component requires a role such as coder or tester");
                };
                if !valid_role(role) {
                    bail!("a worker role must be a stable lowercase identifier");
                }
            } else if role.is_some() {
                bail!("only the worker component carries a role");
            }
            if component_id == COMPONENT_REVIEWER
                && *enabled
                && !has_enabled_component(&next, COMPONENT_WORKER)
            {
                bail!("the reviewer component extends worker; mount an enabled worker first");
            }
            if component_id == COMPONENT_WORKER
                && !*enabled
                && has_enabled_component(&next, COMPONENT_REVIEWER)
            {
                bail!("disable the reviewer component before disabling worker");
            }
            let replacement = AgentComponentEntry {
                component_id: component_id.to_string(),
                schema_version: COMPONENT_SCHEMA_VERSION,
                enabled: *enabled,
                role: role.map(str::to_string),
            };
            match next
                .components
                .iter_mut()
                .find(|component| component.component_id == component_id)
            {
                Some(existing) => *existing = replacement,
                None => next.components.push(replacement),
            }
        }
        AgentSpaceOperation::RemoveComponent { component_id } => {
            let component_id = component_id.trim();
            if !next
                .components
                .iter()
                .any(|component| component.component_id == component_id)
            {
                bail!("this AgentSpace does not have a {component_id} component");
            }
            if component_id == COMPONENT_WORKER && has_enabled_component(&next, COMPONENT_REVIEWER)
            {
                bail!("remove the reviewer component before removing worker");
            }
            next.components
                .retain(|component| component.component_id != component_id);
        }
        AgentSpaceOperation::SetParent {
            parent_workspace_id,
        } => {
            next.parent_workspace_id = parent_workspace_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .map(str::to_string);
        }
        AgentSpaceOperation::SetLifecycle { lifecycle } => {
            let lifecycle = lifecycle.trim();
            if !valid_lifecycle(lifecycle) {
                bail!(
                    "AgentSpace lifecycle must be one of {}",
                    LIFECYCLES.join(", ")
                );
            }
            next.lifecycle = lifecycle.to_string();
        }
    }
    next.components
        .sort_by(|left, right| left.component_id.cmp(&right.component_id));
    Ok(next)
}

/// Tree-wide rules for the registration this Space is about to have.
///
/// `registry` is the current registration set and `proposed` the entry after
/// [`apply`]. Every rule here needs siblings or ancestors, which is why it is
/// separate from the per-Space component contract. Each operation runs the
/// whole set, because a component change can invalidate a tree decision just
/// as much as a reparent can.
pub fn check_tree(registry: &[AgentSpaceEntry], proposed: &AgentSpaceEntry) -> Result<()> {
    let workspace_id = proposed.workspace_id.as_str();
    let has_children = registry
        .iter()
        .any(|space| space.parent_workspace_id.as_deref() == Some(workspace_id));

    // One invariant, checked from both sides: an ephemeral Space is one whose
    // disappearance costs nothing, which cannot be true while a team hangs
    // off it.
    if has_children && proposed.lifecycle == "ephemeral" {
        bail!("an AgentSpace that owns children cannot be ephemeral");
    }

    let Some(parent_id) = proposed.parent_workspace_id.as_deref() else {
        return Ok(());
    };
    if parent_id == workspace_id {
        bail!("an AgentSpace cannot be its own parent");
    }
    let parent = registry
        .iter()
        .find(|space| space.workspace_id == parent_id)
        .filter(|space| space.revision > 0)
        .ok_or_else(|| {
            anyhow::anyhow!("the parent must first be registered as an AgentSpace: {parent_id}")
        })?;
    if parent.lifecycle == "ephemeral" {
        bail!("an ephemeral AgentSpace cannot own children");
    }

    // Walking up from the proposed parent must terminate at a root without
    // passing through this Space. A cycle would leave ownership, project
    // scope and the scheduling boundary all unanswerable.
    let mut cursor = Some(parent);
    let mut depth = 0usize;
    while let Some(space) = cursor {
        depth += 1;
        if depth > MAX_TREE_DEPTH {
            bail!("the AgentSpace tree is deeper than {MAX_TREE_DEPTH} levels");
        }
        if space.workspace_id == workspace_id {
            bail!("this parent would create a cycle in the AgentSpace tree");
        }
        cursor = space.parent_workspace_id.as_deref().and_then(|id| {
            registry
                .iter()
                .find(|candidate| candidate.workspace_id == id)
        });
    }

    check_same_project(registry, proposed, has_children)
}

/// A populated subtree may not change projects.
///
/// Moving a leaf between projects is an ordinary decision — that is how a
/// pooled Worker gets reused. Moving a Space that already owns Workers would
/// carry that whole team, and everything scoped to it, across a project
/// boundary in one call, so it is refused until the children are detached
/// deliberately.
fn check_same_project(
    registry: &[AgentSpaceEntry],
    proposed: &AgentSpaceEntry,
    has_children: bool,
) -> Result<()> {
    if !has_children {
        return Ok(());
    }
    let current_root = registry
        .iter()
        .find(|space| space.workspace_id == proposed.workspace_id)
        .and_then(|space| space.parent_workspace_id.as_deref())
        .map(|parent| project_root(registry, parent));
    let next_root = proposed
        .parent_workspace_id
        .as_deref()
        .map(|parent| project_root(registry, parent));
    match (current_root, next_root) {
        (Some(current), Some(next)) if current != next => {
            bail!("an AgentSpace that owns children cannot be moved to another project")
        }
        _ => Ok(()),
    }
}

/// Topmost ancestor of `workspace_id`, which is the project this Space
/// belongs to. Falls back to the Space itself when the chain is broken, so a
/// malformed registry compares unequal instead of silently matching.
pub fn project_root(registry: &[AgentSpaceEntry], workspace_id: &str) -> String {
    let mut current = workspace_id.to_string();
    for _ in 0..MAX_TREE_DEPTH {
        let Some(parent) = registry
            .iter()
            .find(|space| space.workspace_id == current)
            .and_then(|space| space.parent_workspace_id.clone())
        else {
            return current;
        };
        current = parent;
    }
    current
}

/// The Workers one Executor may dispatch to.
///
/// Direct children only. A child that also mounts `executor` stays a Worker of
/// this Space — it can be handed a whole task — but its own subtree is a new
/// scheduling boundary that this Executor must not enumerate or control.
pub fn schedulable_children<'a>(
    registry: &'a [AgentSpaceEntry],
    executor_workspace_id: &str,
) -> Vec<&'a AgentSpaceEntry> {
    let mut children: Vec<&AgentSpaceEntry> = registry
        .iter()
        .filter(|space| space.parent_workspace_id.as_deref() == Some(executor_workspace_id))
        .filter(|space| has_enabled_component(space, COMPONENT_WORKER))
        .collect();
    children.sort_by(|left, right| left.workspace_id.cmp(&right.workspace_id));
    children
}

pub fn describe(entry: &AgentSpaceEntry) -> AgentSpaceInfo {
    AgentSpaceInfo {
        parent_workspace_id: entry.parent_workspace_id.clone(),
        revision: entry.revision,
        lifecycle: entry.lifecycle.clone(),
        builder_lock_digest: entry.builder_lock_digest.clone(),
        components: entry
            .components
            .iter()
            .map(|component| AgentComponentInfo {
                component_id: component.component_id.clone(),
                schema_version: component.schema_version,
                enabled: component.enabled,
                role: component.role.clone(),
            })
            .collect(),
    }
}

/// States the registration in the terms the exclusive model used, for clients
/// written before components existed. Lossy by construction and derived on
/// every read; nothing consults it to make a decision.
pub fn describe_legacy(entry: &AgentSpaceEntry) -> PipeSpaceInfo {
    let worker_role = if has_enabled_component(entry, COMPONENT_EXECUTOR) {
        Some(LEGACY_EXECUTOR_ROLE.to_string())
    } else {
        enabled_component(entry, COMPONENT_WORKER).and_then(|component| component.role.clone())
    };
    PipeSpaceInfo {
        parent_workspace_id: entry.parent_workspace_id.clone(),
        pm: has_enabled_component(entry, COMPONENT_PM),
        worker_role,
        lifecycle: entry.lifecycle.clone(),
        builder_lock_digest: entry.builder_lock_digest.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(workspace_id: &str, parent: Option<&str>) -> AgentSpaceEntry {
        AgentSpaceEntry {
            workspace_id: workspace_id.to_string(),
            parent_workspace_id: parent.map(str::to_string),
            revision: 1,
            lifecycle: "persistent".into(),
            builder_lock_digest: "sha256:lock".into(),
            components: Vec::new(),
        }
    }

    fn set_component(
        space: &AgentSpaceEntry,
        component_id: &str,
        role: Option<&str>,
    ) -> Result<AgentSpaceEntry> {
        apply(
            space,
            &AgentSpaceOperation::SetComponent {
                component_id: component_id.into(),
                enabled: true,
                role: role.map(str::to_string),
            },
        )
    }

    #[test]
    fn one_space_can_carry_several_responsibilities() {
        let space = entry("ws_a", None);
        let space = set_component(&space, COMPONENT_PM, None).unwrap();
        let space = set_component(&space, COMPONENT_EXECUTOR, None).unwrap();
        let space = set_component(&space, COMPONENT_WORKER, Some("coder")).unwrap();

        assert!(has_enabled_component(&space, COMPONENT_PM));
        assert!(has_enabled_component(&space, COMPONENT_EXECUTOR));
        assert_eq!(
            enabled_component(&space, COMPONENT_WORKER)
                .and_then(|component| component.role.as_deref()),
            Some("coder")
        );
        assert_eq!(
            space
                .components
                .iter()
                .map(|component| component.component_id.as_str())
                .collect::<Vec<_>>(),
            vec![COMPONENT_EXECUTOR, COMPONENT_PM, COMPONENT_WORKER],
            "the projection is sorted so repeated reads are stable"
        );
    }

    #[test]
    fn mounting_the_same_component_twice_is_a_configuration_not_a_duplicate() {
        let space = entry("ws_a", None);
        let space = set_component(&space, COMPONENT_WORKER, Some("coder")).unwrap();
        let space = set_component(&space, COMPONENT_WORKER, Some("tester")).unwrap();

        assert_eq!(space.components.len(), 1);
        assert_eq!(
            space.components[0].role.as_deref(),
            Some("tester"),
            "reconfiguration replaces the contract rather than appending a second one"
        );
    }

    #[test]
    fn component_contract_refuses_unknown_ids_and_misplaced_roles() {
        let space = entry("ws_a", None);
        assert!(set_component(&space, "coder", None)
            .unwrap_err()
            .to_string()
            .contains("unknown component"));
        assert!(set_component(&space, COMPONENT_WORKER, None)
            .unwrap_err()
            .to_string()
            .contains("requires a role"));
        assert!(set_component(&space, COMPONENT_WORKER, Some("Coder"))
            .unwrap_err()
            .to_string()
            .contains("lowercase"));
        assert!(set_component(&space, COMPONENT_EXECUTOR, Some("coder"))
            .unwrap_err()
            .to_string()
            .contains("only the worker component carries a role"));
    }

    #[test]
    fn reviewer_cannot_exist_without_the_worker_it_extends() {
        let space = entry("ws_d", Some("ws_a"));
        assert!(set_component(&space, COMPONENT_REVIEWER, None)
            .unwrap_err()
            .to_string()
            .contains("extends worker"));

        let space = set_component(&space, COMPONENT_WORKER, Some("reviewer")).unwrap();
        let space = set_component(&space, COMPONENT_REVIEWER, None).unwrap();
        let disable_worker = apply(
            &space,
            &AgentSpaceOperation::SetComponent {
                component_id: COMPONENT_WORKER.into(),
                enabled: false,
                role: Some("reviewer".into()),
            },
        );
        assert!(disable_worker
            .unwrap_err()
            .to_string()
            .contains("disable the reviewer component before"));
        assert!(apply(
            &space,
            &AgentSpaceOperation::RemoveComponent {
                component_id: COMPONENT_WORKER.into(),
            }
        )
        .unwrap_err()
        .to_string()
        .contains("remove the reviewer component before"));
    }

    #[test]
    fn removing_a_component_that_was_never_mounted_is_refused() {
        let space = entry("ws_a", None);
        assert!(apply(
            &space,
            &AgentSpaceOperation::RemoveComponent {
                component_id: COMPONENT_EXECUTOR.into(),
            }
        )
        .unwrap_err()
        .to_string()
        .contains("does not have a executor component"));
    }

    #[test]
    fn a_parent_must_be_registered_and_may_not_be_the_space_itself() {
        let registry = vec![entry("ws_a", None)];
        let mut proposed = entry("ws_b", Some("ws_b"));
        assert!(check_tree(&registry, &proposed)
            .unwrap_err()
            .to_string()
            .contains("its own parent"));

        proposed.parent_workspace_id = Some("ws_missing".into());
        assert!(check_tree(&registry, &proposed)
            .unwrap_err()
            .to_string()
            .contains("must first be registered"));

        proposed.parent_workspace_id = Some("ws_a".into());
        check_tree(&registry, &proposed).unwrap();
    }

    #[test]
    fn an_unregistered_space_cannot_be_borrowed_as_a_parent() {
        let mut unregistered = entry("ws_a", None);
        unregistered.revision = 0;
        let registry = vec![unregistered];
        let proposed = entry("ws_b", Some("ws_a"));

        assert!(check_tree(&registry, &proposed)
            .unwrap_err()
            .to_string()
            .contains("must first be registered"));
    }

    #[test]
    fn a_cycle_is_refused_at_any_depth() {
        let registry = vec![
            entry("ws_a", None),
            entry("ws_b", Some("ws_a")),
            entry("ws_c", Some("ws_b")),
        ];
        let proposed = entry("ws_a", Some("ws_c"));

        assert!(check_tree(&registry, &proposed)
            .unwrap_err()
            .to_string()
            .contains("cycle"));
    }

    #[test]
    fn a_space_that_owns_workers_cannot_change_project_or_become_ephemeral() {
        let registry = vec![
            entry("ws_project", None),
            entry("ws_other", None),
            entry("ws_team", Some("ws_project")),
            entry("ws_worker", Some("ws_team")),
        ];

        let moved = entry("ws_team", Some("ws_other"));
        assert!(check_tree(&registry, &moved)
            .unwrap_err()
            .to_string()
            .contains("another project"));

        let mut ephemeral = entry("ws_team", Some("ws_project"));
        ephemeral.lifecycle = "ephemeral".into();
        assert!(check_tree(&registry, &ephemeral)
            .unwrap_err()
            .to_string()
            .contains("cannot be ephemeral"));

        let mut leaf = entry("ws_worker", Some("ws_other"));
        leaf.lifecycle = "ephemeral".into();
        check_tree(&registry, &leaf)
            .expect("a leaf carries nothing with it and may be reused elsewhere");
    }

    #[test]
    fn an_ephemeral_space_is_refused_as_a_parent() {
        let mut throwaway = entry("ws_throwaway", None);
        throwaway.lifecycle = "ephemeral".into();
        let registry = vec![throwaway];
        let proposed = entry("ws_worker", Some("ws_throwaway"));

        assert!(check_tree(&registry, &proposed)
            .unwrap_err()
            .to_string()
            .contains("cannot own children"));
    }

    #[test]
    fn an_executor_sees_direct_workers_only_and_never_reaches_past_a_subteam() {
        let mut project = entry("ws_project", None);
        project.components.push(AgentComponentEntry {
            component_id: COMPONENT_EXECUTOR.into(),
            schema_version: COMPONENT_SCHEMA_VERSION,
            enabled: true,
            role: None,
        });
        let coder = set_component(
            &entry("ws_coder", Some("ws_project")),
            COMPONENT_WORKER,
            Some("coder"),
        )
        .unwrap();
        let subteam = set_component(
            &set_component(
                &entry("ws_subteam", Some("ws_project")),
                COMPONENT_WORKER,
                Some("tester"),
            )
            .unwrap(),
            COMPONENT_EXECUTOR,
            None,
        )
        .unwrap();
        let grandchild = set_component(
            &entry("ws_grandchild", Some("ws_subteam")),
            COMPONENT_WORKER,
            Some("coder"),
        )
        .unwrap();
        let plain_child = entry("ws_plain", Some("ws_project"));
        let registry = vec![project, coder, subteam, grandchild, plain_child];

        let visible: Vec<&str> = schedulable_children(&registry, "ws_project")
            .iter()
            .map(|space| space.workspace_id.as_str())
            .collect();
        assert_eq!(
            visible,
            vec!["ws_coder", "ws_subteam"],
            "a child without an enabled worker is not dispatchable, and a grandchild is never visible"
        );
        assert_eq!(
            schedulable_children(&registry, "ws_subteam")
                .iter()
                .map(|space| space.workspace_id.as_str())
                .collect::<Vec<_>>(),
            vec!["ws_grandchild"],
            "the subteam is its own scheduling boundary"
        );
    }

    #[test]
    fn a_parent_without_the_executor_component_only_owns_structure() {
        let registry = vec![
            entry("ws_plain_parent", None),
            set_component(
                &entry("ws_worker", Some("ws_plain_parent")),
                COMPONENT_WORKER,
                Some("coder"),
            )
            .unwrap(),
        ];

        assert!(
            !has_enabled_component(&registry[0], COMPONENT_EXECUTOR),
            "structure alone must not imply dispatch authority"
        );
        assert_eq!(
            schedulable_children(&registry, "ws_plain_parent").len(),
            1,
            "the tree still reports the child; the caller checks the executor component"
        );
    }

    #[test]
    fn the_legacy_projection_states_the_old_shape_without_storing_it() {
        let project = set_component(&entry("ws_project", None), COMPONENT_PM, None).unwrap();
        let legacy = describe_legacy(&project);
        assert!(legacy.pm);
        assert_eq!(legacy.worker_role, None);

        let executor = set_component(
            &entry("ws_executor", Some("ws_project")),
            COMPONENT_EXECUTOR,
            None,
        )
        .unwrap();
        assert_eq!(
            describe_legacy(&executor).worker_role.as_deref(),
            Some(LEGACY_EXECUTOR_ROLE)
        );

        let tester = set_component(
            &entry("ws_tester", Some("ws_project")),
            COMPONENT_WORKER,
            Some("tester"),
        )
        .unwrap();
        assert_eq!(
            describe_legacy(&tester).worker_role.as_deref(),
            Some("tester")
        );

        let both = set_component(&executor, COMPONENT_WORKER, Some("coder")).unwrap();
        let projected = describe_legacy(&both);
        assert_eq!(
            projected.worker_role.as_deref(),
            Some(LEGACY_EXECUTOR_ROLE),
            "a composed Space cannot be stated in one role; the executor is reported"
        );
        assert_eq!(
            describe(&both)
                .components
                .iter()
                .map(|component| component.component_id.clone())
                .collect::<Vec<_>>(),
            vec![COMPONENT_EXECUTOR.to_string(), COMPONENT_WORKER.to_string()],
            "the component set stays the only complete answer"
        );
    }

    #[test]
    fn a_disabled_component_keeps_its_registration_but_leaves_scheduling() {
        let worker = set_component(
            &entry("ws_worker", Some("ws_project")),
            COMPONENT_WORKER,
            Some("coder"),
        )
        .unwrap();
        let disabled = apply(
            &worker,
            &AgentSpaceOperation::SetComponent {
                component_id: COMPONENT_WORKER.into(),
                enabled: false,
                role: Some("coder".into()),
            },
        )
        .unwrap();

        assert_eq!(disabled.components.len(), 1);
        assert!(!has_enabled_component(&disabled, COMPONENT_WORKER));
        assert!(schedulable_children(&[disabled], "ws_project").is_empty());
    }

    #[test]
    fn lifecycle_is_a_closed_set() {
        let space = entry("ws_a", None);
        assert!(apply(
            &space,
            &AgentSpaceOperation::SetLifecycle {
                lifecycle: "forever".into(),
            }
        )
        .unwrap_err()
        .to_string()
        .contains("lifecycle must be one of"));
        assert_eq!(
            apply(
                &space,
                &AgentSpaceOperation::SetLifecycle {
                    lifecycle: "pooled".into(),
                }
            )
            .unwrap()
            .lifecycle,
            "pooled"
        );
    }
}
