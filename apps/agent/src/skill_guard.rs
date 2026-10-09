//! Deterministic Skill activation (proposal §6.4).
//!
//! The catalog gives a model names and descriptions and leaves reading the
//! file to its judgement, as pi does. That judgement failed in a session that
//! opened on imported history naming `openplay-guidance` eight times: the
//! model copied an existing guidance file instead and read SKILL.md only when
//! the user pointed it out. Two nudges, each derived from the session itself
//! so a restart or a resumed session sees the same facts:
//!
//! - a prompt that names a Skill whose SKILL.md is not in this session gets a
//!   reminder carrying the path (never the body), once per Skill;
//! - a write or edit inside what a Skill owns, before its SKILL.md was read,
//!   gets a note on its tool result, once per Skill.
//!
//! Only Skills this agent put in its own catalog are covered. The daemon's
//! built-in Skills (`disable_model_invocation` here, see `skills.rs`) are
//! reminded by the daemon for every Agent alike.

use std::path::{Component, Path, PathBuf};

use globset::Glob;
use serde_json::Value;

use crate::protocol::{Content, Message};
use crate::skills::Skill;

const REMINDER_TAG: &str = "<skill_reminder name=\"";
const WRITE_NOTE_MARK: &str = "whose SKILL.md has not been read in this session";

/// The reminder to append to a prompt, or None when every Skill it names is
/// already read or already reminded.
pub fn prompt_reminder(
    text: &str,
    skills: &[Skill],
    history: &[Message],
    cwd: &Path,
) -> Option<String> {
    let notes: Vec<String> = mentioned(text, skills)
        .into_iter()
        .filter(|skill| !was_read(skill, history, &[], cwd) && !was_reminded(skill, history))
        .map(|skill| {
            format!(
                "{REMINDER_TAG}{}\">This request names the Skill `{}`. Before acting on it, read `{}` with the read tool and follow it; do not infer its rules from files it produced earlier.</skill_reminder>",
                skill.name,
                skill.name,
                skill.file_path.display()
            )
        })
        .collect();
    (!notes.is_empty()).then(|| notes.join("\n"))
}

/// The note for a write or edit at `raw_path`, or None.
///
/// `batch` is the assistant message's own calls: a read of SKILL.md issued
/// beside the write runs concurrently with it, so it counts.
pub fn write_note(
    raw_path: &str,
    skills: &[Skill],
    history: &[Message],
    batch: &[(String, String, Value)],
    cwd: &Path,
) -> Option<(String, String)> {
    let path = lexical(&crate::tools::resolve_path(cwd, raw_path));
    let skill = skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation)
        .find(|skill| owns(skill, &path, cwd))?;
    if was_read(skill, history, batch, cwd) || was_noted(skill, history) {
        return None;
    }
    Some((
        skill.name.clone(),
        format!(
            "\n\nNote: `{}` belongs to the Skill `{}`, {WRITE_NOTE_MARK}. Read `{}` and check this change against it before going further.",
            path.display(),
            skill.name,
            skill.file_path.display()
        ),
    ))
}

/// Skills named as a whole token. Case-sensitive: Skill names are kebab-case
/// identifiers, and folding case would make `genehub` fire on every mention
/// of the product.
fn mentioned<'a>(text: &str, skills: &'a [Skill]) -> Vec<&'a Skill> {
    let tokens: std::collections::HashSet<&str> = text
        .split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_'))
        .filter(|token| !token.is_empty())
        .collect();
    skills
        .iter()
        .filter(|skill| !skill.disable_model_invocation && tokens.contains(skill.name.as_str()))
        .collect()
}

/// A Skill owns its own directory (a SKILL.md skill, not a loose `.md` file)
/// and whatever its `paths` globs name, relative to the working directory.
fn owns(skill: &Skill, path: &Path, cwd: &Path) -> bool {
    let is_root = skill
        .file_path
        .file_name()
        .is_some_and(|name| name == "SKILL.md");
    if is_root && path.starts_with(lexical(&skill.base_dir)) {
        return true;
    }
    let relative = path.strip_prefix(lexical(cwd)).ok();
    skill.paths.iter().any(|pattern| {
        let Ok(glob) = Glob::new(pattern) else {
            return false;
        };
        let matcher = glob.compile_matcher();
        // `guidance/` and `guidance` both mean everything under it.
        let under = pattern.trim_end_matches('/');
        let dir = Glob::new(&format!("{under}/**"))
            .ok()
            .map(|glob| glob.compile_matcher());
        let hit = |candidate: &Path| {
            matcher.is_match(candidate) || dir.as_ref().is_some_and(|dir| dir.is_match(candidate))
        };
        hit(path) || relative.is_some_and(hit)
    })
}

fn was_read(
    skill: &Skill,
    history: &[Message],
    batch: &[(String, String, Value)],
    cwd: &Path,
) -> bool {
    let target = lexical(&skill.file_path);
    let spelled = skill.file_path.to_string_lossy();
    let reads = |name: &str, arguments: &Value| match name {
        "read" => arguments
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|raw| lexical(&crate::tools::resolve_path(cwd, raw)) == target),
        "bash" => arguments
            .get("command")
            .and_then(Value::as_str)
            .is_some_and(|command| command.contains(spelled.as_ref())),
        _ => false,
    };
    if batch
        .iter()
        .any(|(_, name, arguments)| reads(name, arguments))
    {
        return true;
    }
    // `/skill:name` puts the file itself in a user message.
    let body = std::fs::read_to_string(&skill.file_path).ok();
    history.iter().any(|message| match message {
        Message::Assistant { content, .. } => content.iter().any(|block| match block {
            Content::ToolCall {
                name, arguments, ..
            } => reads(name, arguments),
            _ => false,
        }),
        Message::User { content, .. } => body
            .as_deref()
            .is_some_and(|body| !body.trim().is_empty() && content.starts_with(body)),
        Message::ToolResult { .. } => false,
    })
}

fn was_reminded(skill: &Skill, history: &[Message]) -> bool {
    let tag = format!("{REMINDER_TAG}{}\"", skill.name);
    history
        .iter()
        .any(|message| matches!(message, Message::User { content, .. } if content.contains(&tag)))
}

fn was_noted(skill: &Skill, history: &[Message]) -> bool {
    let mark = format!("the Skill `{}`, {WRITE_NOTE_MARK}", skill.name);
    history.iter().any(|message| match message {
        Message::ToolResult { content, .. } => content
            .iter()
            .any(|block| matches!(block, Content::Text { text } if text.contains(&mark))),
        _ => false,
    })
}

/// `a/./b/../c` as `a/c`, without touching the filesystem: the file being
/// written may not exist yet.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn tempdir() -> TempDir {
        let dir = std::env::temp_dir().join(format!("genet-skill-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    fn skill(dir: &Path, name: &str, paths: &[&str]) -> Skill {
        let base_dir = dir.join(".agents/skills").join(name);
        std::fs::create_dir_all(&base_dir).unwrap();
        let file_path = base_dir.join("SKILL.md");
        std::fs::write(
            &file_path,
            format!("---\nname: {name}\ndescription: d\n---\nRules.\n"),
        )
        .unwrap();
        Skill {
            name: name.into(),
            description: "d".into(),
            file_path,
            base_dir,
            disable_model_invocation: false,
            paths: paths.iter().map(|p| p.to_string()).collect(),
        }
    }

    fn read_call(path: &Path) -> Message {
        Message::Assistant {
            content: vec![Content::ToolCall {
                id: "c1".into(),
                name: "read".into(),
                arguments: json!({ "path": path.to_string_lossy() }),
            }],
            api: String::new(),
            provider: String::new(),
            model: String::new(),
            usage: Default::default(),
            stop_reason: crate::protocol::StopReason::ToolUse,
            error_message: None,
            timestamp: 0,
        }
    }

    /// §1.1: the imported history named `openplay-guidance` eight times and
    /// the model never opened it.
    #[test]
    fn a_named_skill_that_was_never_read_is_pointed_at_once() {
        let dir = tempdir();
        let skills = vec![skill(dir.path(), "openplay-guidance", &[])];
        let text = "继续按 openplay-guidance 巡查，写 guidance/patrol/04.md";
        let reminder = prompt_reminder(text, &skills, &[], dir.path()).expect("a reminder");
        assert!(reminder.contains(&skills[0].file_path.display().to_string()));
        assert!(
            !reminder.contains("Rules."),
            "the body stays out of context"
        );

        let reminded = vec![Message::user(format!("{text}\n\n{reminder}"))];
        assert!(prompt_reminder(text, &skills, &reminded, dir.path()).is_none());
        let read = vec![read_call(&skills[0].file_path)];
        assert!(prompt_reminder(text, &skills, &read, dir.path()).is_none());
    }

    #[test]
    fn only_whole_names_in_their_own_case_count() {
        let dir = tempdir();
        let skills = vec![skill(dir.path(), "genehub", &[])];
        for text in [
            "GeneHub 很好用",
            "~/.local/share/GeneHub-beta/x",
            "genehub-preview 页面",
        ] {
            assert!(
                prompt_reminder(text, &skills, &[], dir.path()).is_none(),
                "{text}"
            );
        }
        assert!(prompt_reminder("用 genehub 看看", &skills, &[], dir.path()).is_some());
    }

    #[test]
    fn writing_where_a_skill_owns_before_reading_it_is_noted_once() {
        let dir = tempdir();
        let skills = vec![skill(dir.path(), "openplay-guidance", &["guidance/"])];
        let cwd = dir.path();

        let (name, note) =
            write_note("guidance/patrol/04.md", &skills, &[], &[], cwd).expect("a note");
        assert_eq!(name, "openplay-guidance");
        assert!(note.contains("SKILL.md"));
        // Its own folder counts without any `paths`.
        assert!(write_note(
            ".agents/skills/openplay-guidance/x.md",
            &skills,
            &[],
            &[],
            cwd
        )
        .is_some());
        assert!(write_note("src/main.rs", &skills, &[], &[], cwd).is_none());

        let noted = vec![Message::ToolResult {
            tool_call_id: "c".into(),
            tool_name: "write".into(),
            content: vec![Content::text(format!("Wrote it.{note}"))],
            details: None,
            is_error: false,
            timestamp: 0,
        }];
        assert!(write_note("guidance/a.md", &skills, &noted, &[], cwd).is_none());
        let read = vec![read_call(&skills[0].file_path)];
        assert!(write_note("guidance/a.md", &skills, &read, &[], cwd).is_none());
        let beside = vec![(
            "c2".to_string(),
            "read".to_string(),
            json!({ "path": skills[0].file_path.to_string_lossy() }),
        )];
        assert!(write_note("guidance/a.md", &skills, &[], &beside, cwd).is_none());
    }

    #[test]
    fn skills_the_daemon_reminds_for_are_left_to_it() {
        let dir = tempdir();
        let mut builtin = skill(dir.path(), "genehub-preview", &["site/"]);
        builtin.disable_model_invocation = true;
        let skills = vec![builtin];
        assert!(prompt_reminder("genehub-preview", &skills, &[], dir.path()).is_none());
        assert!(write_note("site/index.html", &skills, &[], &[], dir.path()).is_none());
    }
}
