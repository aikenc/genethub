//! The machine's administrator: an expert that ships with the product.
//!
//! It is an ordinary Space on disk — `<data>/spaces/admin/` — made from the same template any expert is made
//! from, plus one more Skill (`expert-admin`) that knows how to make the others. Nothing here is special to
//! the rest of the daemon: the scan registers it like any Space, and SpaceBuilder builds it like any Space.
//!
//! What the product owns and what it does not:
//!   - owned, rewritten on every start if it differs: the descriptors, `skills/`, `tools/`;
//!   - created once and then left alone: `soul.md`, `memory.md` (the expert writes those);
//!   - never touched: everything else in the directory.
//!
//! A Space the user removed is not put back.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::state::Shared;

const TEMPLATE: &str = "genehub/references/expert-template/";
const ADMIN_SKILL: &str = "genehub/references/expert-admin-skill/";
const BUILDER: &str = "genehub/references/spacebuilder/spacebuilder.py";
/// Files the expert itself keeps: written when missing, never overwritten.
const EXPERT_OWNED: &[&str] = &["soul.md", "memory.md"];
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
    let script = crate::skills::builtin_skills_dir(&state.paths.root).join(BUILDER);
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

/// Writes what the product owns. Returns whether anything on disk changed.
pub fn refresh(admin: &Path, name: &str) -> std::io::Result<bool> {
    let mut changed = false;
    let mut put = |relative: &str, contents: &[u8], overwrite: bool| -> std::io::Result<()> {
        let target = admin.join(relative);
        match std::fs::read(&target) {
            Ok(existing) if !overwrite || existing == contents => return Ok(()),
            _ => {}
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(&target, contents)?;
        changed = true;
        Ok(())
    };
    for (relative, contents) in crate::skills::builtin_files_under(TEMPLATE) {
        if relative == "agent-space.genet.json" {
            put(relative, &admin_descriptor(contents, name), true)?;
        } else {
            put(relative, contents, !EXPERT_OWNED.contains(&relative))?;
        }
    }
    for (relative, contents) in crate::skills::builtin_files_under(ADMIN_SKILL) {
        put(&format!("skills/{relative}"), contents, true)?;
    }
    Ok(changed)
}

/// The template's root descriptor, named for this machine and given the administrator's Skill.
fn admin_descriptor(template: &[u8], name: &str) -> Vec<u8> {
    let mut descriptor: Value =
        serde_json::from_slice(template).expect("the template descriptor is valid JSON");
    descriptor["name"] = json!(name);
    descriptor["description"] =
        json!("这台机器上的管理员：介绍专家、新建专家、clone 别人共享的专家集、答疑。");
    if let Some(skills) = descriptor["skills"].as_array_mut() {
        skills.push(json!("expert-admin"));
    }
    let mut bytes = serde_json::to_vec_pretty(&descriptor).expect("a JSON value serializes");
    bytes.push(b'\n');
    bytes
}

async fn build(script: &Path, admin: &Path, python: Option<PathBuf>) -> Result<(), String> {
    let program = python.unwrap_or_else(|| PathBuf::from("python3"));
    let argv = crate::process::launch_argv(&program.to_string_lossy(), None)
        .map_err(|e| format!("{e:#}"))?;
    let arguments = vec![
        script.to_string_lossy().into_owned(),
        "build".to_string(),
        admin.to_string_lossy().into_owned(),
        "--format".to_string(),
        "json".to_string(),
    ];
    let mut command = crate::process::command(&argv, &arguments, admin);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_is_the_machine_plus_the_suffix_and_always_valid() {
        assert_eq!(admin_name("办公室-Mac"), "办公室-Mac管理员");
        assert_eq!(admin_name("  dev/box\\1\n "), "devbox1管理员");
        assert_eq!(admin_name(""), "本机管理员");
        assert_eq!(admin_name("\n/\\"), "本机管理员");
        let long = admin_name(&"机".repeat(200));
        assert_eq!(long.chars().count(), NAME_LIMIT);
        assert!(
            long.ends_with(SUFFIX),
            "the suffix is never the part that is cut"
        );
    }

    #[test]
    fn refresh_installs_the_template_and_the_admin_skill_and_names_the_space() {
        let data = tempfile::tempdir().unwrap();
        let admin = data.path().join("spaces/admin");
        assert!(refresh(&admin, "办公室-Mac管理员").unwrap());
        let descriptor: Value =
            serde_json::from_slice(&std::fs::read(admin.join("agent-space.genet.json")).unwrap())
                .unwrap();
        assert_eq!(descriptor["name"], "办公室-Mac管理员");
        assert_eq!(descriptor["tags"], json!(["expert"]));
        assert_eq!(descriptor["agentCwd"], "front");
        assert_eq!(
            descriptor["skills"],
            json!(["expert-core", "expert-front", "expert-admin"])
        );
        for file in [
            "tools/expert.py",
            "skills/expert-core/SKILL.md",
            "skills/expert-front/hooks/timer.genet.json",
            "skills/expert-admin/SKILL.md",
            "spaces/think/agent-space.genet.json",
            "spaces/work/agent-space.genet.json",
            "soul.md",
            "memory.md",
        ] {
            assert!(admin.join(file).is_file(), "{file} missing");
        }
        assert!(
            !refresh(&admin, "办公室-Mac管理员").unwrap(),
            "a second run changes nothing"
        );
    }

    #[test]
    fn what_the_product_owns_is_restored_and_what_the_expert_owns_is_not_touched() {
        let data = tempfile::tempdir().unwrap();
        let admin = data.path().join("spaces/admin");
        refresh(&admin, "甲管理员").unwrap();
        std::fs::write(admin.join("soul.md"), "my own soul").unwrap();
        std::fs::write(admin.join("memory.md"), "my memory").unwrap();
        std::fs::write(admin.join("tools/expert.py"), "# edited").unwrap();
        std::fs::create_dir_all(admin.join("posts")).unwrap();
        std::fs::write(admin.join("posts/x.md"), "git@example/x.git").unwrap();
        std::fs::write(admin.join("skills/expert-core/SKILL.md"), "edited").unwrap();

        assert!(refresh(&admin, "乙管理员").unwrap());
        assert_eq!(
            std::fs::read_to_string(admin.join("soul.md")).unwrap(),
            "my own soul"
        );
        assert_eq!(
            std::fs::read_to_string(admin.join("memory.md")).unwrap(),
            "my memory"
        );
        assert_eq!(
            std::fs::read_to_string(admin.join("posts/x.md")).unwrap(),
            "git@example/x.git"
        );
        assert_ne!(
            std::fs::read_to_string(admin.join("tools/expert.py")).unwrap(),
            "# edited"
        );
        assert_ne!(
            std::fs::read_to_string(admin.join("skills/expert-core/SKILL.md")).unwrap(),
            "edited"
        );
        let descriptor: Value =
            serde_json::from_slice(&std::fs::read(admin.join("agent-space.genet.json")).unwrap())
                .unwrap();
        assert_eq!(
            descriptor["name"], "乙管理员",
            "a renamed machine renames the descriptor"
        );
    }
}
