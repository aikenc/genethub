//! The platform knows no Agent by name. An Agent is a directory under
//! `builtin-agents/agents/<id>/` (or the user's own); everything particular to
//! it — actions, logins, layouts, wording — is declared by its script. This
//! scans the platform's own source and fails when a name creeps back in, so the
//! rule does not depend on anyone remembering it.
//!
//! Test code, comments, documentation and the built-in Agents themselves are
//! not scanned. What is allowed to stay is listed below, each with its reason;
//! the two deprecated subsystems leave the list when they are removed.

use std::fs;
use std::path::{Path, PathBuf};

const NAMES: [&str; 6] = [
    "codex",
    "claude",
    "codebuddy",
    "opencode",
    "tclaude",
    "cursor-agent",
];

/// Source paths (relative to the repository root) that may still name Agents.
const ALLOWED: [(&str, &str); 4] = [
    (
        "apps/daemon/src/agent_space_builder/",
        "deprecated; removed with the subsystem (docs/deprecated.md)",
    ),
    (
        "apps/daemon/src/workflow/",
        "deprecated; removed with the subsystem (docs/deprecated.md)",
    ),
    (
        "packages/workflow-engine/",
        "deprecated; removed with the subsystem (docs/deprecated.md)",
    ),
    ("apps/daemon/src/speech/", "speech models, not Agents"),
];

/// Whole lines that are model or provider identifiers, not Agent logic.
fn is_model_identifier(line: &str) -> bool {
    // `claude-3-7` and friends are model-family substrings in the capability
    // rules (`capabilities.rs`), not the Claude Code Agent.
    ["claude-sonnet", "claude-opus", "claude-haiku", "claude-3"]
        .iter()
        .any(|model| line.contains(model))
}

fn source_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            if matches!(
                name.as_str(),
                "node_modules"
                    | "target"
                    | "bindings"
                    | "deprecated"
                    | "tests"
                    | "builtin-agents"
                    | "dist"
                    | "fixtures"
            ) {
                continue;
            }
            source_files(&path, out);
        } else if matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("rs" | "ts" | "tsx")
        ) && !name.contains("test")
            && !name.ends_with(".d.ts")
        {
            out.push(path);
        }
    }
}

/// Everything before the file's trailing `#[cfg(test)] mod`, without comment lines.
fn production_lines(text: &str) -> Vec<(usize, &str)> {
    let end = text
        .find("#[cfg(test)]\nmod ")
        .or_else(|| text.find("#[cfg(test)]\n#[allow"))
        .unwrap_or(text.len());
    text[..end]
        .lines()
        .enumerate()
        .map(|(index, line)| (index + 1, line))
        .filter(|(_, line)| {
            let trimmed = line.trim_start();
            !(trimmed.starts_with("//") || trimmed.starts_with('*') || trimmed.starts_with("/*"))
        })
        .collect()
}

#[test]
fn the_platform_source_names_no_agent() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut files = Vec::new();
    for base in ["apps", "packages"] {
        let Ok(children) = fs::read_dir(root.join(base)) else {
            continue;
        };
        for child in children.flatten() {
            source_files(&child.path().join("src"), &mut files);
        }
    }
    assert!(
        files.len() > 100,
        "the scan found only {} files; the layout changed",
        files.len()
    );

    let mut found = Vec::new();
    for file in files {
        let relative = file
            .strip_prefix(&root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        let relative = relative.trim_start_matches("../").to_string();
        if ALLOWED.iter().any(|(prefix, _)| relative.contains(prefix)) {
            continue;
        }
        let Ok(text) = fs::read_to_string(&file) else {
            continue;
        };
        for (number, line) in production_lines(&text) {
            let lowered = line.to_lowercase();
            if is_model_identifier(&lowered) {
                continue;
            }
            if let Some(name) = NAMES.iter().find(|name| lowered.contains(*name)) {
                found.push(format!("{relative}:{number}: {name}: {}", line.trim()));
            }
        }
    }
    assert!(
        found.is_empty(),
        "the platform must not name an Agent; declare it in the Agent's script instead:\n{}",
        found.join("\n")
    );
}
