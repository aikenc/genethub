//! Skill discovery and prompt injection, following the open Agent Skills
//! standard (<https://agentskills.io/specification>) so skill folders written
//! for other harnesses work here unchanged.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;

const MAX_NAME_LENGTH: usize = 64;
const MAX_DESCRIPTION_LENGTH: usize = 1024;
struct BuiltinFile {
    relative_path: &'static str,
    contents: &'static str,
}

const BUILTIN_FILES: &[BuiltinFile] = &[
    BuiltinFile {
        relative_path: "genehub-session-history/SKILL.md",
        contents: include_str!("../builtin-skills/genehub-session-history/SKILL.md"),
    },
    BuiltinFile {
        relative_path: "genehub-speech-runtime/SKILL.md",
        contents: include_str!("../builtin-skills/genehub-speech-runtime/SKILL.md"),
    },
    BuiltinFile {
        relative_path: "genehub-speech-runtime/agents/openai.yaml",
        contents: include_str!("../builtin-skills/genehub-speech-runtime/agents/openai.yaml"),
    },
    BuiltinFile {
        relative_path: "genehub-speech-runtime/references/models.md",
        contents: include_str!("../builtin-skills/genehub-speech-runtime/references/models.md"),
    },
    BuiltinFile {
        relative_path: "genehub-speech-runtime/references/runtime-contract.md",
        contents: include_str!(
            "../builtin-skills/genehub-speech-runtime/references/runtime-contract.md"
        ),
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub file_path: PathBuf,
    pub base_dir: PathBuf,
    pub disable_model_invocation: bool,
}

/// Global then project locations; on a name collision the first one wins.
pub fn load(cwd: &Path, agent_dir: &Path) -> Vec<Skill> {
    let builtin_dir = materialize_builtins(agent_dir);
    let mut skills: Vec<Skill> = Vec::new();
    let mut push = |found: Vec<Skill>| {
        for skill in found {
            if !skills.iter().any(|existing| existing.name == skill.name) {
                skills.push(skill);
            }
        }
    };

    push(load_dir(&agent_dir.join("skills"), true));
    if let Some(home) = home_dir() {
        push(load_dir(&home.join(".agents").join("skills"), false));
    }
    push(load_dir(&cwd.join(".genehub").join("skills"), true));
    push(load_dir(&cwd.join(".agents").join("skills"), false));
    if let Some(dir) = builtin_dir {
        // Built-ins are guaranteed fallbacks. A user or project skill with the
        // same name intentionally wins, which keeps the extension point real.
        push(load_dir(&dir, false));
    }

    skills.sort_by(|a, b| a.name.cmp(&b.name));
    skills
}

fn materialize_builtins(agent_dir: &Path) -> Option<PathBuf> {
    let root = agent_dir.join("builtin-skills");
    for file in BUILTIN_FILES {
        let target = root.join(file.relative_path);
        if std::fs::read_to_string(&target).ok().as_deref() == Some(file.contents) {
            continue;
        }
        let Some(parent) = target.parent() else {
            return None;
        };
        if let Err(error) = std::fs::create_dir_all(parent) {
            eprintln!(
                "genet-agent: could not create built-in skill directory for {}: {error}",
                file.relative_path
            );
            return None;
        }
        let file_name = target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("builtin");
        let temporary = parent.join(format!(".{file_name}.{}.tmp", std::process::id()));
        let installed = std::fs::write(&temporary, file.contents).and_then(|_| {
            std::fs::rename(&temporary, &target).or_else(|first_error| {
                // Windows does not replace an existing destination with rename.
                // This fallback loses atomic replacement but keeps upgrades from
                // silently dropping a built-in Skill on that platform.
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
            eprintln!(
                "genet-agent: could not install built-in file {}: {error}",
                file.relative_path
            );
            return None;
        }
    }
    Some(root)
}

/// Only our own skill directories treat loose `.md` files as skills; shared
/// `.agents/skills` trees may hold unrelated markdown.
fn load_dir(dir: &Path, root_md_files: bool) -> Vec<Skill> {
    if !dir.is_dir() {
        return Vec::new();
    }

    let mut skills = Vec::new();

    if root_md_files {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().is_some_and(|ext| ext == "md") {
                    if let Some(skill) = parse_skill_file(&path) {
                        skills.push(skill);
                    }
                }
            }
        }
    }

    // A directory holding SKILL.md is a skill root and we do not recurse past
    // it. Walk order is unspecified, so collect first and sort: a parent path
    // always sorts before the paths nested under it.
    let mut candidates: Vec<PathBuf> = WalkBuilder::new(dir)
        .hidden(false)
        .git_ignore(true)
        .build()
        .flatten()
        .map(|entry| entry.into_path())
        .filter(|path| path.file_name().is_some_and(|name| name == "SKILL.md"))
        .collect();
    candidates.sort();

    let mut roots: Vec<PathBuf> = Vec::new();
    for path in candidates {
        let Some(parent) = path.parent() else {
            continue;
        };
        if roots.iter().any(|root| parent.starts_with(root)) {
            continue;
        }
        roots.push(parent.to_path_buf());
        if let Some(skill) = parse_skill_file(&path) {
            skills.push(skill);
        }
    }

    skills
}

fn parse_skill_file(path: &Path) -> Option<Skill> {
    let raw = std::fs::read_to_string(path).ok()?;
    let frontmatter = parse_frontmatter(&raw);

    let parent_dir_name = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let fallback_name = if path.file_name().is_some_and(|n| n == "SKILL.md") {
        parent_dir_name
    } else {
        path.file_stem()?.to_string_lossy().to_string()
    };

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

    // A skill the model cannot judge from its description is worse than absent.
    if name.is_empty() || name.len() > MAX_NAME_LENGTH {
        eprintln!(
            "genet-agent: skipping skill with invalid name: {}",
            path.display()
        );
        return None;
    }
    if description.trim().is_empty() || description.len() > MAX_DESCRIPTION_LENGTH {
        eprintln!(
            "genet-agent: skipping skill without a usable description: {}",
            path.display()
        );
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
        base_dir: path.parent().unwrap_or(Path::new(".")).to_path_buf(),
        disable_model_invocation,
    })
}

/// Minimal YAML frontmatter: flat `key: value` pairs between `---` fences,
/// which is all the skill spec requires.
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

/// Progressive disclosure: only names, descriptions and locations stay in
/// context; the model reads the file itself when a task matches.
pub fn format_for_prompt(skills: &[Skill]) -> String {
    let visible: Vec<&Skill> = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .collect();
    if visible.is_empty() {
        return String::new();
    }

    let mut lines = vec![
        "\n\nThe following skills provide specialized instructions for specific tasks.".to_string(),
        "Use the read tool to load a skill's file when the task matches its description."
            .to_string(),
        "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.".to_string(),
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

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .ok()
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-skills-{tag}-{}", uuid::Uuid::new_v4()));
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
    fn frontmatter_pairs_are_parsed() {
        let pairs = parse_frontmatter("---\nname: demo\ndescription: does things\n---\nbody\n");
        assert_eq!(pairs[0], ("name".into(), "demo".into()));
        assert_eq!(pairs[1], ("description".into(), "does things".into()));
    }

    #[test]
    fn skill_dir_is_discovered_and_named_from_frontmatter() {
        let dir = temp_dir("discover");
        write_skill(
            &dir,
            "pdf",
            "---\nname: pdf-tools\ndescription: Work with PDFs\n---\n",
        );
        let skills = load_dir(&dir, false);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "pdf-tools");
        assert_eq!(skills[0].description, "Work with PDFs");
    }

    #[test]
    fn name_falls_back_to_parent_directory() {
        let dir = temp_dir("fallback");
        write_skill(
            &dir,
            "brave-search",
            "---\ndescription: Search the web\n---\n",
        );
        let skills = load_dir(&dir, false);
        assert_eq!(skills[0].name, "brave-search");
    }

    #[test]
    fn skills_without_description_are_skipped() {
        let dir = temp_dir("nodesc");
        write_skill(&dir, "broken", "---\nname: broken\n---\n");
        assert!(load_dir(&dir, false).is_empty());
    }

    #[test]
    fn nested_directories_below_a_skill_root_are_not_rescanned() {
        let dir = temp_dir("nested");
        let root = dir.join("outer");
        std::fs::create_dir_all(root.join("references")).unwrap();
        std::fs::write(
            root.join("SKILL.md"),
            "---\nname: outer\ndescription: Outer\n---\n",
        )
        .unwrap();
        std::fs::write(
            root.join("references").join("SKILL.md"),
            "---\nname: inner\ndescription: Inner\n---\n",
        )
        .unwrap();

        let skills = load_dir(&dir, false);
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "outer");
    }

    #[test]
    fn prompt_block_matches_pi_wording() {
        let skills = vec![Skill {
            name: "pdf".into(),
            description: "Handle <PDFs> & more".into(),
            file_path: PathBuf::from("/skills/pdf/SKILL.md"),
            base_dir: PathBuf::from("/skills/pdf"),
            disable_model_invocation: false,
        }];
        let prompt = format_for_prompt(&skills);
        assert!(prompt.starts_with("\n\nThe following skills provide specialized instructions"));
        assert!(prompt.contains("<available_skills>"));
        assert!(prompt.contains("    <name>pdf</name>"));
        assert!(prompt.contains("&lt;PDFs&gt; &amp; more"));
        assert!(prompt.contains("    <location>/skills/pdf/SKILL.md</location>"));
        assert!(prompt.ends_with("</available_skills>"));
    }

    #[test]
    fn model_invocation_can_be_disabled() {
        let skills = vec![Skill {
            name: "hidden".into(),
            description: "Not for the model".into(),
            file_path: PathBuf::from("/skills/hidden/SKILL.md"),
            base_dir: PathBuf::from("/skills/hidden"),
            disable_model_invocation: true,
        }];
        assert!(format_for_prompt(&skills).is_empty());
    }

    #[test]
    fn built_in_session_history_skill_is_materialized_and_discovered() {
        let cwd = temp_dir("builtin-cwd");
        let agent_dir = temp_dir("builtin-agent");
        let skills = load(&cwd, &agent_dir);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-session-history")
            .expect("built-in skill");
        assert!(skill
            .file_path
            .starts_with(agent_dir.join("builtin-skills")));
        assert!(std::fs::read_to_string(&skill.file_path)
            .unwrap()
            .contains("GENEHUB_SESSION_ID"));
    }

    #[test]
    fn built_in_speech_runtime_skill_and_references_are_materialized() {
        let cwd = temp_dir("speech-builtin-cwd");
        let agent_dir = temp_dir("speech-builtin-agent");
        let skills = load(&cwd, &agent_dir);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-speech-runtime")
            .expect("built-in speech runtime skill");
        assert!(std::fs::read_to_string(&skill.file_path)
            .unwrap()
            .contains("speech runtime register"));
        assert!(skill.base_dir.join("references/models.md").is_file());
        assert!(skill
            .base_dir
            .join("references/runtime-contract.md")
            .is_file());
        assert!(skill.base_dir.join("agents/openai.yaml").is_file());
    }

    #[test]
    fn project_skill_can_override_the_built_in_fallback() {
        let cwd = temp_dir("override-cwd");
        let agent_dir = temp_dir("override-agent");
        let override_path = write_skill(
            &cwd.join(".agents").join("skills"),
            "genehub-session-history",
            "---\nname: genehub-session-history\ndescription: Project override\n---\n",
        );
        let skills = load(&cwd, &agent_dir);
        let skill = skills
            .iter()
            .find(|skill| skill.name == "genehub-session-history")
            .unwrap();
        assert_eq!(skill.file_path, override_path);
        assert_eq!(skill.description, "Project override");
    }
}
