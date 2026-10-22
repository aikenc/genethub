//! The environment an Agent says belongs to the session that launched us.
//!
//! A daemon is often started from inside another Agent's shell, and whatever
//! this process inherits reaches every terminal, remote command and script it
//! later starts — they would speak for a session they are not part of, on
//! possibly another channel's daemon. The endpoint is what breaks: the
//! launching CLI still holds the port, so every CLI this daemon starts fails
//! to bind and stays alive and silent forever.
//!
//! Which names those are is the Agent's business, so the Agent declares them
//! (`agent.genet.json`, `launchingEnv`) and this module reads the tree the
//! daemon materialised. The platform keeps only what is not any Agent's:
//! a fixed port/host pair and the trace context.

use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

/// What the platform knows without any Agent.
pub const PLATFORM_NAMES: &[&str] = &[
    "SERVER__PORT",
    "SERVER__HOST",
    "TRACEPARENT",
    "TRACESTATE",
    "BAGGAGE",
];

const MANIFEST: &str = "agent.genet.json";

/// Enough to tell whether the tree changed: one entry per manifest that
/// exists, with the two things a rewrite moves.
type Fingerprint = Vec<(String, u64, Option<SystemTime>)>;

static CACHE: Mutex<Option<(Fingerprint, Vec<String>)>> = Mutex::new(None);

fn fingerprint(root: &Path) -> Fingerprint {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut found: Fingerprint = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let meta = std::fs::metadata(entry.path().join(MANIFEST)).ok()?;
            Some((name, meta.len(), meta.modified().ok()))
        })
        .collect();
    found.sort();
    found
}

pub fn launching_env_in(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return names;
    };
    for entry in entries.flatten() {
        let Ok(raw) = std::fs::read_to_string(entry.path().join(MANIFEST)) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&raw) else {
            continue;
        };
        let Some(declared) = manifest.get("launchingEnv").and_then(|v| v.as_array()) else {
            continue;
        };
        for name in declared.iter().filter_map(|value| value.as_str()) {
            if !names.iter().any(|seen| seen == name) {
                names.push(name.to_string());
            }
        }
    }
    names.sort();
    names
}

/// The names every Agent currently declares, from the materialised tree.
///
/// Read once per change: the fingerprint is a `read_dir` and a handful of
/// stats, and the manifests are only parsed when it moves. Callers do not have
/// to care when the daemon last rewrote the tree.
pub fn launching_env() -> Vec<String> {
    let Some(root) = crate::data_dir::builtin_agents() else {
        return Vec::new();
    };
    let now = fingerprint(&root);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((cached, names)) = cache.as_ref() {
        if *cached == now {
            return names.clone();
        }
    }
    let names = launching_env_in(&root);
    *cache = Some((now, names.clone()));
    names
}

/// Everything a spawned process must not inherit: what the Agents declare plus
/// what the platform knows on its own.
pub fn forgotten() -> Vec<String> {
    let mut names: Vec<String> = PLATFORM_NAMES.iter().map(|name| name.to_string()).collect();
    for name in launching_env() {
        if !names.iter().any(|seen| seen == &name) {
            names.push(name);
        }
    }
    names
}

/// The same list for an explicit Agent tree, so the answer can be checked
/// without a materialised one.
#[cfg(test)]
pub fn forgotten_in(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = PLATFORM_NAMES.iter().map(|name| name.to_string()).collect();
    for name in launching_env_in(root) {
        if !names.iter().any(|seen| seen == &name) {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, agent: &str, body: &str) {
        let path = dir.join(agent);
        std::fs::create_dir_all(&path).unwrap();
        std::fs::write(path.join(MANIFEST), body).unwrap();
    }

    #[test]
    fn an_agents_own_declaration_is_found() {
        let dir = std::env::temp_dir().join(format!("genehub-agent-env-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        write(
            &dir,
            "one",
            r#"{"label":"One","launchingEnv":["ONE_SESSION_ID"]}"#,
        );
        write(
            &dir,
            "two",
            r#"{"label":"Two","launchingEnv":["TWO_SESSION_ID","ONE_SESSION_ID"]}"#,
        );
        assert_eq!(
            launching_env_in(&dir),
            vec!["ONE_SESSION_ID".to_string(), "TWO_SESSION_ID".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_tree_without_manifests_declares_nothing() {
        let dir = std::env::temp_dir().join(format!("genehub-agent-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(launching_env_in(&dir).is_empty());
        assert_eq!(forgotten_in(&dir), PLATFORM_NAMES.to_vec());
    }
}
