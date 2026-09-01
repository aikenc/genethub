//! System prompt construction: tool list, guidelines, project context, skills,
//! then the working directory.

use std::path::Path;

use crate::skills::{self, Skill};

const CONTEXT_FILES: [&str; 2] = ["AGENTS.md", "GENEHUB.md"];

const TOOL_SNIPPETS: [(&str, &str); 8] = [
    ("read", "read a file, optionally a line range"),
    ("write", "create or overwrite a file"),
    ("edit", "apply targeted replacements to a file"),
    ("ls", "list a directory"),
    ("grep", "search file contents"),
    ("find", "find files by glob"),
    ("bash", "run a shell command"),
    (
        "genehub",
        "batch exact GeneHub CLI argv without shell parsing",
    ),
];

pub fn build(cwd: &Path, skills: &[Skill], additional_system_prompts: &[String]) -> String {
    let tools_list = TOOL_SNIPPETS
        .iter()
        .map(|(name, snippet)| format!("- {name}: {snippet}"))
        .collect::<Vec<_>>()
        .join("\n");

    let guidelines = ["Show file paths clearly when working with files"]
        .iter()
        .map(|guideline| format!("- {guideline}"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut prompt = format!(
        "You are an expert coding assistant operating inside {}, a coding agent harness. \
You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
{tools_list}

Guidelines:
{guidelines}",
        crate::channel::PRODUCT
    );

    let context_files = load_context_files(cwd);
    if !context_files.is_empty() {
        prompt.push_str("\n\n<project_context>\n\n");
        prompt.push_str("Project-specific instructions and guidelines:\n\n");
        for (path, content) in &context_files {
            prompt.push_str(&format!(
                "<project_instructions path=\"{path}\">\n{content}\n</project_instructions>\n\n"
            ));
        }
        prompt.push_str("</project_context>\n");
    }

    if !skills.is_empty() {
        prompt.push_str(&skills::format_for_prompt(skills));
    }

    for additional in additional_system_prompts {
        if additional.trim().is_empty() {
            continue;
        }
        prompt.push_str("\n\n<additional_system_prompt>\n");
        prompt.push_str(additional);
        prompt.push_str("\n</additional_system_prompt>");
    }

    prompt.push_str(&format!(
        "\nCurrent working directory: {}",
        cwd.to_string_lossy().replace('\\', "/")
    ));

    prompt
}

fn load_context_files(cwd: &Path) -> Vec<(String, String)> {
    let mut files = Vec::new();
    for name in CONTEXT_FILES {
        let path = cwd.join(name);
        if let Ok(content) = std::fs::read_to_string(&path) {
            files.push((path.to_string_lossy().to_string(), content));
        }
    }
    files
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-prompt-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn prompt_lists_tools_and_ends_with_cwd() {
        let dir = temp_dir("basic");
        let prompt = build(&dir, &[], &[]);
        assert!(prompt.contains("- bash: run a shell command"));
        assert!(prompt.contains("Guidelines:"));
        assert!(prompt
            .trim_end()
            .ends_with(&dir.to_string_lossy().to_string()));
    }

    #[test]
    fn agents_md_is_injected_as_project_context() {
        let dir = temp_dir("context");
        std::fs::write(dir.join("AGENTS.md"), "always run tests").unwrap();
        let prompt = build(&dir, &[], &[]);
        assert!(prompt.contains("<project_context>"));
        assert!(prompt.contains("always run tests"));
    }

    #[test]
    fn skills_block_appears_before_the_cwd_line() {
        let dir = temp_dir("skills");
        let skills = vec![Skill {
            name: "demo".into(),
            description: "Demo skill".into(),
            file_path: dir.join("SKILL.md"),
            base_dir: dir.clone(),
            disable_model_invocation: false,
        }];
        let prompt = build(&dir, &skills, &[]);
        let skills_at = prompt.find("<available_skills>").unwrap();
        let cwd_at = prompt.find("Current working directory:").unwrap();
        assert!(skills_at < cwd_at);
    }

    #[test]
    fn additional_system_prompt_is_after_project_context_and_before_cwd() {
        let dir = temp_dir("additional");
        let prompt = build(
            &dir,
            &[],
            &["Use https://app.example/assets/preview/v2/device/workspace/r_root/".into()],
        );
        let added_at = prompt.find("<additional_system_prompt>").unwrap();
        let cwd_at = prompt.find("Current working directory:").unwrap();
        assert!(added_at < cwd_at);
        assert!(prompt.contains("https://app.example/assets/preview/v2/device/workspace/r_root/"));
    }
}
