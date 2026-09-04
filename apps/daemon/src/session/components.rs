//! Component Instances: what a Session is an instance *of*.
//!
//! A Session is the running instance of its AgentSpace, so every
//! responsibility mounted on that Space is present in every one of its
//! Sessions. There is no separate act of attaching a component to a
//! conversation, and no per-Session component list to drift from the Space's.
//!
//! The list is therefore **derived live** rather than snapshotted at creation.
//! Mounting `reviewer` on a Space makes the reviewer present in the Sessions
//! already open on it, which is the behaviour an ordinary coding agent already
//! has for its skills and prompts: improve them and keep working. Only an
//! in-flight Run pins what it judges by, and it does that with its own
//! copy-on-pin snapshot, not by freezing the Session.
//!
//! Each instance owns storage in two scopes, and the distinction is the whole
//! point of having two:
//!
//! * **Space scope** outlives every Session. It is where a responsibility
//!   keeps what belongs to the Space itself — an Executor's flow ledger, a
//!   PM's project state — so closing a conversation does not lose it.
//! * **Session scope** belongs to one conversation and is reclaimed with it.
//!
//! Directories are created when an instance is resolved rather than when a
//! Session is created: the same code path then serves a Session that predates
//! the component, and a Space whose composition changed while the Session was
//! open. An instance that has never written anything still exists; it just has
//! empty storage.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::agent_space::COMPONENT_IDS;
use crate::config::AgentComponentEntry;

/// The directory name both scopes use, under the Space home and under one
/// Session's directory respectively.
const COMPONENTS_DIR: &str = "components";

/// One responsibility, live in one Session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ComponentInstance {
    pub component_id: String,
    /// The Worker role this instance carries, when the component defines one.
    pub role: Option<String>,
    /// Storage shared by every Session of this Space.
    pub space_dir: PathBuf,
    /// Storage private to this Session.
    pub session_dir: PathBuf,
}

/// Rejects any component id that is not one of the known contracts.
///
/// The ids reach here from durable configuration, and both scopes turn one
/// into a directory name. A closed set is what keeps that from being a path
/// the caller chose: `..` never becomes a component.
fn known(component_id: &str) -> bool {
    COMPONENT_IDS.contains(&component_id)
}

fn space_components_dir(space_home: &Path) -> PathBuf {
    space_home.join(COMPONENTS_DIR)
}

fn session_components_dir(session_dir: &Path) -> PathBuf {
    session_dir.join(COMPONENTS_DIR)
}

/// Resolves the instances a Session currently has, creating their storage.
///
/// `components` is the Space's registration as read now, so the answer follows
/// the Space rather than the Session's age. Disabled and unknown components
/// are absent: an instance exists exactly when the responsibility is mounted
/// and enabled.
pub fn resolve(
    space_home: &Path,
    session_dir: &Path,
    components: &[AgentComponentEntry],
) -> Result<Vec<ComponentInstance>> {
    let mut instances = Vec::new();
    for component in components {
        if !component.enabled || !known(&component.component_id) {
            continue;
        }
        let space_dir = space_components_dir(space_home).join(&component.component_id);
        let session_dir = session_components_dir(session_dir).join(&component.component_id);
        std::fs::create_dir_all(&space_dir)
            .with_context(|| format!("creating {} space storage", component.component_id))?;
        std::fs::create_dir_all(&session_dir)
            .with_context(|| format!("creating {} session storage", component.component_id))?;
        instances.push(ComponentInstance {
            component_id: component.component_id.clone(),
            role: component.role.clone(),
            space_dir,
            session_dir,
        });
    }
    instances.sort_by(|left, right| left.component_id.cmp(&right.component_id));
    Ok(instances)
}

/// Storage for one instance without resolving the whole set, for a caller that
/// already knows which responsibility it is acting as.
pub fn instance_dirs(
    space_home: &Path,
    session_dir: &Path,
    component_id: &str,
) -> Result<(PathBuf, PathBuf)> {
    anyhow::ensure!(known(component_id), "unknown component: {component_id}");
    let space_dir = space_components_dir(space_home).join(component_id);
    let session_scoped = session_components_dir(session_dir).join(component_id);
    std::fs::create_dir_all(&space_dir)
        .with_context(|| format!("creating {component_id} space storage"))?;
    std::fs::create_dir_all(&session_scoped)
        .with_context(|| format!("creating {component_id} session storage"))?;
    Ok((space_dir, session_scoped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_space::{
        COMPONENT_EXECUTOR, COMPONENT_PM, COMPONENT_REVIEWER, COMPONENT_WORKER,
    };

    fn component(id: &str, enabled: bool, role: Option<&str>) -> AgentComponentEntry {
        AgentComponentEntry {
            component_id: id.to_string(),
            schema_version: crate::agent_space::COMPONENT_SCHEMA_VERSION,
            enabled,
            role: role.map(str::to_string),
        }
    }

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp dir")
    }

    #[test]
    fn a_session_has_one_instance_per_enabled_component_of_its_space() {
        let dir = scratch();
        let space_home = dir.path().join(".genethub");
        let session_dir = space_home.join("sessions").join("s_1");
        let instances = resolve(
            &space_home,
            &session_dir,
            &[
                component(COMPONENT_PM, true, None),
                component(COMPONENT_EXECUTOR, true, None),
                component(COMPONENT_WORKER, false, Some("coder")),
            ],
        )
        .expect("resolve");

        let ids: Vec<&str> = instances
            .iter()
            .map(|instance| instance.component_id.as_str())
            .collect();
        assert_eq!(ids, vec![COMPONENT_EXECUTOR, COMPONENT_PM]);
        for instance in &instances {
            assert!(instance.space_dir.is_dir(), "space scope was not created");
            assert!(
                instance.session_dir.is_dir(),
                "session scope was not created"
            );
        }
    }

    #[test]
    fn the_two_scopes_are_different_directories() {
        let dir = scratch();
        let space_home = dir.path().join(".genethub");
        let session_dir = space_home.join("sessions").join("s_1");
        let instances = resolve(
            &space_home,
            &session_dir,
            &[component(COMPONENT_WORKER, true, Some("coder"))],
        )
        .expect("resolve");
        let worker = &instances[0];
        assert_ne!(worker.space_dir, worker.session_dir);
        assert!(
            worker.session_dir.starts_with(&session_dir),
            "session scope escaped the session directory"
        );
        assert_eq!(worker.role.as_deref(), Some("coder"));

        // What the Space keeps must survive the conversation that wrote it.
        std::fs::write(worker.space_dir.join("ledger"), b"kept").expect("write");
        std::fs::write(worker.session_dir.join("scratch"), b"transient").expect("write");
        std::fs::remove_dir_all(&session_dir).expect("close the session");
        assert!(worker.space_dir.join("ledger").is_file());
    }

    #[test]
    fn mounting_a_component_reaches_a_session_that_is_already_open() {
        let dir = scratch();
        let space_home = dir.path().join(".genethub");
        let session_dir = space_home.join("sessions").join("s_1");
        let before = resolve(
            &space_home,
            &session_dir,
            &[component(COMPONENT_WORKER, true, Some("coder"))],
        )
        .expect("resolve");
        assert_eq!(before.len(), 1);

        let after = resolve(
            &space_home,
            &session_dir,
            &[
                component(COMPONENT_WORKER, true, Some("coder")),
                component(COMPONENT_REVIEWER, true, None),
            ],
        )
        .expect("resolve");
        assert_eq!(after.len(), 2, "a newly mounted component stayed invisible");
    }

    #[test]
    fn a_component_id_can_never_be_a_path() {
        let dir = scratch();
        let space_home = dir.path().join(".genethub");
        let session_dir = space_home.join("sessions").join("s_1");
        let instances = resolve(
            &space_home,
            &session_dir,
            &[component("../../escape", true, None)],
        )
        .expect("resolve");
        assert!(
            instances.is_empty(),
            "an unknown id was turned into a directory"
        );
        assert!(
            instance_dirs(&space_home, &session_dir, "..").is_err(),
            "a traversal id was accepted"
        );
    }
}
