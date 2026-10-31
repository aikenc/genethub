//! The machine's administrator: a Space that ships with the product and sets up teams.
//!
//! It is an ordinary Space on disk — `<data>/spaces/admin/` — made from the same template any team is made
//! from, plus one more Skill (`team-admin`) that knows how to make the teams. Nothing here is special to
//! the rest of the daemon: the scan registers it like any Space, and SpaceBuilder builds it like any Space.
//!
//! The built-in administrator is stateless product-owned bootstrap material:
//!   - rewritten on every start if it differs: every file from `team-template/` (except its child Spaces —
//!     the administrator is one Space plus `team-admin`, with no background Spaces of its own) and
//!     `team-admin-skill/`;
//!   - only files recorded in the previous bootstrap ownership manifest are pruned;
//!     unrelated files and untracked legacy material are preserved;
//!   - runtime and build-output paths (`.genethub/`, `.spacebuilder/`, `temp/`, `datas/`, `posts/`, and SpaceBuilder
//!     target files) are preserved.
//!
//! A Space the user removed is not put back.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::state::Shared;

const TEMPLATE: &str = "genehub/references/team-template/";
const ADMIN_SKILL: &str = "genehub/references/team-admin-skill/";
const BUILDER: &str = "genehub/references/spacebuilder/spacebuilder.py";
const BUILD_TIMEOUT: Duration = Duration::from_secs(60);
const NAME_LIMIT: usize = 64;
const SUFFIX: &str = "管理员";

/// Puts the administrator in place and builds it. Failures are logged, never fatal: the daemon is useful
/// without an administrator, and the next start tries again.
pub async fn ensure_admin(state: &Shared) {
    let admin = state.paths.root.join("spaces").join("admin");
    if state.workspaces.was_removed(&admin).await {
        return;
    }
    let name = admin_name(&crate::link::default_display_name());
    let changed = match refresh(&admin, &name) {
        Ok(changed) => changed,
        Err(error) => {
            tracing::warn!(dir = %admin.display(), %error, "could not put the administrator in place");
            return;
        }
    };
    if !changed && admin.join(".spacebuilder").join("lock.json").is_file() {
        return;
    }
    let script = crate::space_descriptor::space_builder(&admin)
        .unwrap_or_else(|| crate::skills::builtin_skills_dir(&state.paths.root).join(BUILDER));
    match build(&script, &admin, state.registry.python()).await {
        Ok(()) => tracing::info!(dir = %admin.display(), "the administrator is built"),
        Err(error) => {
            tracing::warn!(dir = %admin.display(), %error, "building the administrator failed")
        }
    }
}

/// "<machine>管理员", safe to use as a Space name: one line, no path separators, within the length SpaceBuilder
/// accepts. The machine part is shortened, never the suffix.
pub fn admin_name(machine: &str) -> String {
    let cleaned: String = machine
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '/' | '\\'))
        .collect();
    let cleaned = cleaned.trim();
    let keep = NAME_LIMIT - SUFFIX.chars().count();
    let shortened: String = cleaned.chars().take(keep).collect();
    let shortened = shortened.trim_end();
    if shortened.is_empty() {
        "本机管理员".to_string()
    } else {
        format!("{shortened}{SUFFIX}")
    }
}

/// Writes what the product owns and prunes stale template files. Returns whether anything on disk changed.
pub fn refresh(admin: &Path, name: &str) -> std::io::Result<bool> {
    let mut changed = false;
    let mut shipped = HashSet::new();
    let owned = spacebuilder_owned_paths(admin);
    let manifest = admin.join(".genethub").join("bootstrap-owned.json");
    let previous: HashSet<String> = match std::fs::read(&manifest) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(std::io::Error::other)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashSet::new(),
        Err(error) => return Err(error),
    };
    let mut put = |relative: &str, contents: &[u8]| -> std::io::Result<()> {
        shipped.insert(relative.replace('\\', "/"));
        let target = admin.join(relative);
        if let Ok(existing) = std::fs::read(&target) {
            if existing == contents {
                return Ok(());
            }
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, contents)?;
        changed = true;
        Ok(())
    };
    for (relative, contents) in crate::skills::builtin_files_under(TEMPLATE) {
        // The administrator is one Space plus one Skill: it answers the person itself and never runs
        // background Spaces, so the team's child Spaces are not part of it.
        if relative.starts_with("spaces/") {
            continue;
        }
        if relative == "agent-space.genet.json" {
            put(relative, &admin_descriptor(contents, name))?;
        } else {
            put(relative, contents)?;
        }
    }
    for (relative, contents) in crate::skills::builtin_files_under(ADMIN_SKILL) {
        put(&format!("skills/{relative}"), contents)?;
    }
    for relative in previous.difference(&shipped) {
        if is_preserved_runtime_or_build_path(relative, &owned) {
            continue;
        }
        let path = Path::new(relative);
        if path
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err(std::io::Error::other("invalid bootstrap ownership path"));
        }
        let mut parent = admin.to_path_buf();
        for part in path.components() {
            parent.push(part);
            if parent.is_symlink() {
                return Err(std::io::Error::other(
                    "bootstrap ownership path traverses a symbolic link",
                ));
            }
        }
        match std::fs::remove_file(admin.join(path)) {
            Ok(()) => changed = true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    if previous != shipped {
        crate::config::save_private(
            &manifest,
            &serde_json::to_vec(&shipped).map_err(std::io::Error::other)?,
        )
        .map_err(std::io::Error::other)?;
    }
    Ok(changed)
}

fn is_preserved_runtime_or_build_path(rel: &str, owned: &HashSet<String>) -> bool {
    if owned.contains(rel) {
        return true;
    }
    let first = rel.split('/').next().unwrap_or_default();
    if matches!(
        first,
        ".genethub" | ".spacebuilder" | "posts" | "datas" | "temp"
    ) {
        return true;
    }
    let last = rel.rsplit('/').next().unwrap_or_default();
    if last.ends_with(".code-workspace") {
        return true;
    }
    rel.split('/')
        .any(|segment| matches!(segment, ".genethub" | ".spacebuilder"))
}

fn spacebuilder_owned_paths(admin: &Path) -> HashSet<String> {
    let mut owned = HashSet::new();
    let Ok(bytes) = std::fs::read(admin.join(".spacebuilder").join("lock.json")) else {
        return owned;
    };
    let Ok(lock) = serde_json::from_slice::<Value>(&bytes) else {
        return owned;
    };
    let Some(spaces) = lock.get("spaces").and_then(Value::as_array) else {
        return owned;
    };
    for space in spaces {
        let space_path = space.get("path").and_then(Value::as_str).unwrap_or(".");
        let prefix = if space_path == "." || space_path.is_empty() {
            String::new()
        } else {
            format!("{}/", space_path.trim_matches('/'))
        };
        if let Some(files) = space.get("ownedFiles").and_then(Value::as_array) {
            for file in files {
                if let Some(rel) = file.get("path").and_then(Value::as_str) {
                    owned.insert(format!("{prefix}{}", rel.trim_start_matches('/')));
                }
            }
        }
    }
    owned
}

/// The template's root descriptor, named for this machine and given the administrator's Skill.
fn admin_descriptor(template: &[u8], name: &str) -> Vec<u8> {
    let mut descriptor: Value =
        serde_json::from_slice(template).expect("the template descriptor is valid JSON");
    descriptor["name"] = json!(name);
    descriptor["description"] =
        json!("这台机器上的管理员：建立和管理项目团队、clone 共享团队、答疑。");
    if let Some(skills) = descriptor["skills"].as_array_mut() {
        skills.push(json!("team-admin"));
    }
    // One Space, no children: nothing scans under the administrator for role Spaces that do not exist.
    descriptor["children"] = json!({ "scanDepth": 0 });
    let mut bytes = serde_json::to_vec_pretty(&descriptor).expect("a JSON value serializes");
    bytes.push(b'\n');
    bytes
}

async fn build(script: &Path, admin: &Path, python: Option<PathBuf>) -> Result<(), String> {
    let program = python.unwrap_or_else(|| PathBuf::from("python3"));
    let arguments = vec![
        script.to_string_lossy().into_owned(),
        "build".to_string(),
        admin.to_string_lossy().into_owned(),
        "--format".to_string(),
        "json".to_string(),
    ];
    let mut command = crate::process::command(&program, &arguments, admin);
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = crate::process::Group::spawn(&mut command)
        .map_err(|e| format!("could not start {}: {e}", program.display()))?;
    let mut report = Vec::new();
    for pipe in [
        child.stdout().map(|p| tokio::spawn(read_all(p))),
        child.stderr().map(|p| tokio::spawn(read_all(p))),
    ]
    .into_iter()
    .flatten()
    {
        report.push(pipe);
    }
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        () = tokio::time::sleep(BUILD_TIMEOUT) => child.end().await,
    };
    let mut output = String::new();
    for task in report {
        if let Ok(text) = task.await {
            output.push_str(&text);
        }
    }
    match status {
        Some(status) if status.success() => Ok(()),
        _ => Err(format!(
            "the SpaceBuilder did not finish cleanly: {}",
            output.trim().chars().take(600).collect::<String>()
        )),
    }
}

async fn read_all<R: tokio::io::AsyncRead + Unpin>(mut pipe: R) -> String {
    use tokio::io::AsyncReadExt;
    let mut bytes = Vec::new();
    let _ = pipe.read_to_end(&mut bytes).await;
    String::from_utf8_lossy(&bytes).into_owned()
}
