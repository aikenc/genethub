//! Daemon-owned Skills: materialize built-ins and inject one catalog
//! into every Agent session.
//!
//! Third-party Agents do not need a native Skill loader. They receive
//! `{name, description, path}` and read the file when a task matches.

use std::path::{Path, PathBuf};

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;

struct BuiltinFile {
    relative_path: &'static str,
    contents: &'static str,
}

const BUILTIN_FILES: &[BuiltinFile] = &[BuiltinFile {
    relative_path: "genehub-session-history/SKILL.md",
    contents: include_str!("../builtin-skills/genehub-session-history/SKILL.md"),
}];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub disable_model_invocation: bool,
}

/// `<data-dir>/skills` — GeneHub-owned built-ins, materialized from this crate.
pub fn skills_dir(data_root: &Path) -> PathBuf {
    data_root.join("skills")
}

/// Write built-in Skill files so Agents can `read` a real path.
pub fn materialize(root: &Path) -> Option<PathBuf> {
    for file in BUILTIN_FILES {
        let target = root.join(file.relative_path);
        if std::fs::read_to_string(&target).ok().as_deref() == Some(file.contents) {
            continue;
        }
        let parent = target.parent()?;
        if let Err(error) = std::fs::create_dir_all(parent) {
            tracing::warn!(
                path = %file.relative_path,
                %error,
                "could not create built-in skill directory"
            );
            return None;
        }
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("builtin");
        let temporary = parent.join(format!(".{file_name}.{}.tmp", crate::host_pid::current()));
        let installed = std::fs::write(&temporary, file.contents).and_then(|_| {
            std::fs::rename(&temporary, &target).or_else(|first_error| {
                if target.exists() {
                    std::fs::remove_file(&target)?;
                    std::fs::rename(&temporary, &target)
                } else {
                    Err(first_error)
                }
            })
        });
        if let Err(error) = installed {
            let _ = std::fs::remove_file(&temporary);
            tracing::warn!(
                path = %file.relative_path,
                %error,
                "could not install built-in skill file"
            );
            return None;
        }
    }
    Some(root.to_path_buf())
}

/// Built-ins first and reserved. Workspace overlay may add new names only.
pub fn load(skills_root: &Path, cwd: &Path) -> Vec<Skill> {
    let mut skills = Vec::new();
    let mut reserved = Vec::new();
    if let Some(dir) = materialize(skills_root) {
        for skill in load_dir(&dir) {
            reserved.push(skill.name.clone());
            skills.push(skill);
        }
    }
    // Future project overlay. Nothing in a PipeSpace ships here yet.
    for dir in [
        cwd.join(".genethub").join("skills"),
        cwd.join(".genehub").join("skills"),
    ] {
        for skill in load_dir(&dir) {
            if reserved.iter().any(|name| name == &skill.name) {
                continue;
            }
            if skills.iter().any(|existing| existing.name == skill.name) {
                continue;
            }
            skills.push(skill);
        }
    }
    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

/// Artifact-link rules plus the Skill catalog, or just the rules when
/// this daemon has no skills directory.
pub fn session_guidance(skills_root: Option<&Path>, cwd: &Path) -> String {
    let artifact = crate::session::artifact_links::guidance().to_string();
    let Some(root) = skills_root else {
        return artifact;
    };
    let catalog = format_catalog(&load(root, cwd));
    if catalog.is_empty() {
        artifact
    } else {
        format!("{artifact}\n\n{catalog}")
    }
}

pub fn format_catalog(skills: &[Skill]) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }

    let mut lines = vec![
        "GeneHub provides these Skills as ordinary files. When a task matches a skill description, read that file and follow it. Do not invent skill names or session ids.".to_string(),
        String::new(),
        "<available_skills>".to_string(),
    ];
    for skill in visible {
        lines.push("  <skill>".to_string());
        lines.push(format!("    <name>{}</name>", escape_xml(&skill.name)));
        lines.push(format!(
            "    <description>{}</description>",
            escape_xml(&skill.description)
        ));
        lines.push(format!(
            "    <location>{}</location>",
            escape_xml(&skill.file_path.to_string_lossy())
        ));
        lines.push("  </skill>".to_string());
    }
    lines.push("</available_skills>".to_string());
    lines.join("\n")
}

fn load_dir(dir: &Path) -> Vec<Skill> {
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut skills = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return skills;
    };
    let mut children: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    children.sort();
    for child in children {
        let skill_file = child.join("SKILL.md");
        if let Some(skill) = parse_skill_file(&skill_file) {
            skills.push(skill);
        }
    }
    skills
}

fn parse_skill_file(path: &Path) -> Option<Skill> {
    let raw = std::fs::read_to_string(path).ok()?;
    let frontmatter = parse_frontmatter(&raw);
    let fallback_name = path
        .parent()
        .and_then(|parent| parent.file_name())
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = frontmatter
        .iter()
        .find(|(key, _)| key == "name")
        .map(|(_, value)| value.clone())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_name);
    let description = frontmatter
        .iter()
        .find(|(key, _)| key == "description")
        .map(|(_, value)| value.clone())
        .unwrap_or_default();
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        return None;
    }
    if description.trim().is_empty() || description.len() > MAX_DESCRIPTION_LENGTH {
        return None;
    }
    let disable_model_invocation = frontmatter
        .iter()
        .find(|(key, _)| key == "disable-model-invocation")
        .map(|(_, value)| value == "true")
        .unwrap_or(false);
    Some(Skill {
        name,
        description,
        file_path: path.to_path_buf(),
        disable_model_invocation,
    })
}

fn parse_frontmatter(raw: &str) -> Vec<(String, String)> {
    let mut pairs = Vec::new();
    let mut lines = raw.lines();
    if lines.next().map(str::trim) != Some("---") {
        return pairs;
    }
    for line in lines {
        if line.trim() == "---" {
            break;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches('"').trim_matches('\'');
        pairs.push((key.trim().to_string(), value.to_string()));
    }
    pairs
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "genet-daemon-skills-{tag}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_skill(dir: &Path, name: &str, body: &str) -> PathBuf {
        let skill_dir = dir.join(name);
        std::fs::create_dir_all(&skill_dir).unwrap();
        let path = skill_dir.join("SKILL.md");
        std::fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn session_history_is_materialized_under_the_daemon_skills_dir() {
        let root = temp_dir("builtin");
        let cwd = temp_dir("cwd");
        let skills = load(&root, &cwd);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-session-history")
            .expect("built-in skill");
        assert!(skill.file_path.starts_with(&root));
        let body = std::fs::read_to_string(&skill.file_path).unwrap();
        assert!(body.contains("schema session.inspect"));
        assert!(body.contains("--through-round"));
        assert!(!body.contains("session inspect \"$GENEHUB_SESSION_ID\""));
    }

    #[test]
    fn workspace_overlay_cannot_replace_a_built_in_name() {
        let root = temp_dir("reserved");
        let cwd = temp_dir("overlay-cwd");
        write_skill(
            &cwd.join(".genethub").join("skills"),
            "genehub-session-history",
            "---\nname: genehub-session-history\ndescription: Project override\n---\n",
        );
        let skills = load(&root, &cwd);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-session-history")
            .unwrap();
        assert!(skill.file_path.starts_with(&root));
        assert_ne!(skill.description, "Project override");
    }

    #[test]
    fn workspace_overlay_can_add_a_new_skill() {
        let root = temp_dir("extra");
        let cwd = temp_dir("extra-cwd");
        write_skill(
            &cwd.join(".genethub").join("skills"),
            "local-notes",
            "---\nname: local-notes\ndescription: Project notes helper\n---\n",
        );
        let skills = load(&root, &cwd);
        assert!(skills.iter().any(|skill| skill.name == "local-notes"));
        assert!(skills
            .iter()
            .any(|skill| skill.name == "genehub-session-history"));
    }

    #[test]
    fn catalog_lists_name_description_and_path() {
        let skills = vec![Skill {
            name: "demo".into(),
            description: "Handle <PDFs> & more".into(),
            file_path: PathBuf::from("/data/skills/demo/SKILL.md"),
            disable_model_invocation: false,
        }];
        let catalog = format_catalog(&skills);
        assert!(catalog.contains("<available_skills>"));
        assert!(catalog.contains("<name>demo</name>"));
        assert!(catalog.contains("&lt;PDFs&gt; &amp; more"));
        assert!(catalog.contains("<location>/data/skills/demo/SKILL.md</location>"));
        assert!(catalog.contains("Do not invent skill names"));
    }

    #[test]
    fn session_guidance_keeps_artifact_rules_and_appends_the_catalog() {
        let root = temp_dir("guidance");
        let cwd = temp_dir("guidance-cwd");
        let prompt = session_guidance(Some(&root), &cwd);
        assert!(prompt.contains("index.html"));
        assert!(prompt.contains("genehub-session-history"));
        assert!(prompt.contains("<available_skills>"));
    }

    #[test]
    fn session_guidance_without_a_root_is_artifact_rules_only() {
        let cwd = temp_dir("none");
        let prompt = session_guidance(None, &cwd);
        assert!(prompt.contains("index.html"));
        assert!(!prompt.contains("available_skills"));
    }
}
