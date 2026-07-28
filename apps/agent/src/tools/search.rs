//! grep / find — gitignore-aware traversal, so generated and vendored files do
//! not drown the results.

use std::path::Path;

use globset::GlobBuilder;
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::Value;

use super::{
    arg_bool, arg_str, arg_usize, resolve_path, truncate_head, ToolResult, DEFAULT_MAX_BYTES,
    GREP_MAX_LINE_LENGTH,
};

pub const GREP_DEFAULT_LIMIT: usize = 100;
pub const FIND_DEFAULT_LIMIT: usize = 1000;

pub fn grep(args: &Value, cwd: &Path) -> ToolResult {
    let Some(pattern) = arg_str(args, "pattern") else {
        return ToolResult::error("grep: 'pattern' is required");
    };
    let root = match arg_str(args, "path") {
        Some(raw) => resolve_path(cwd, &raw),
        None => cwd.to_path_buf(),
    };
    let limit = arg_usize(args, "limit").unwrap_or(GREP_DEFAULT_LIMIT);
    let context = arg_usize(args, "context").unwrap_or(0);

    let escaped;
    let expression = if arg_bool(args, "literal") {
        escaped = regex::escape(&pattern);
        escaped.as_str()
    } else {
        pattern.as_str()
    };
    let regex = match RegexBuilder::new(expression)
        .case_insensitive(arg_bool(args, "ignoreCase"))
        .build()
    {
        Ok(regex) => regex,
        Err(err) => return ToolResult::error(format!("grep: invalid pattern: {err}")),
    };

    let glob = match arg_str(args, "glob") {
        Some(raw) => match GlobBuilder::new(&raw).literal_separator(false).build() {
            Ok(glob) => Some(glob.compile_matcher()),
            Err(err) => return ToolResult::error(format!("grep: invalid glob: {err}")),
        },
        None => None,
    };

    let mut rows: Vec<String> = Vec::new();
    let mut matches = 0usize;

    'files: for entry in WalkBuilder::new(&root).hidden(false).build().flatten() {
        if !entry.file_type().is_some_and(|file| file.is_file()) {
            continue;
        }
        let path = entry.path();
        if let Some(glob) = &glob {
            let relative = path.strip_prefix(&root).unwrap_or(path);
            if !glob.is_match(relative) && !glob.is_match(path) {
                continue;
            }
        }
        let Ok(content) = std::fs::read_to_string(path) else {
            continue; // binary or unreadable
        };

        let lines: Vec<&str> = content.lines().collect();
        for (index, line) in lines.iter().enumerate() {
            if !regex.is_match(line) {
                continue;
            }
            let start = index.saturating_sub(context);
            let end = (index + context + 1).min(lines.len());
            for (offset, context_line) in lines[start..end].iter().enumerate() {
                let number = start + offset + 1;
                let separator = if start + offset == index { ':' } else { '-' };
                rows.push(format!(
                    "{}{separator}{number}{separator}{}",
                    path.display(),
                    clamp_line(context_line)
                ));
            }
            matches += 1;
            if matches >= limit {
                break 'files;
            }
        }
    }

    if rows.is_empty() {
        return ToolResult::ok("No matches found");
    }

    // The match limit already caps rows, so only the byte limit applies.
    let truncation = truncate_head(&rows.join("\n"), usize::MAX, DEFAULT_MAX_BYTES);
    ToolResult::ok(truncation.content.clone()).with_truncation(&truncation)
}

pub fn find(args: &Value, cwd: &Path) -> ToolResult {
    let Some(pattern) = arg_str(args, "pattern") else {
        return ToolResult::error("find: 'pattern' is required");
    };
    let root = match arg_str(args, "path") {
        Some(raw) => resolve_path(cwd, &raw),
        None => cwd.to_path_buf(),
    };
    let limit = arg_usize(args, "limit").unwrap_or(FIND_DEFAULT_LIMIT);

    let glob = match GlobBuilder::new(&pattern).literal_separator(false).build() {
        Ok(glob) => glob.compile_matcher(),
        Err(err) => return ToolResult::error(format!("find: invalid glob: {err}")),
    };

    let mut hits: Vec<String> = Vec::new();
    for entry in WalkBuilder::new(&root).hidden(false).build().flatten() {
        if !entry.file_type().is_some_and(|file| file.is_file()) {
            continue;
        }
        let path = entry.path();
        let relative = path.strip_prefix(&root).unwrap_or(path);
        if !glob.is_match(relative) && !glob.is_match(path) {
            continue;
        }
        if hits.len() >= limit {
            break;
        }
        hits.push(relative.to_string_lossy().to_string());
    }

    if hits.is_empty() {
        return ToolResult::ok("No files found matching pattern");
    }

    hits.sort();
    let truncation = truncate_head(&hits.join("\n"), usize::MAX, DEFAULT_MAX_BYTES);
    ToolResult::ok(truncation.content.clone()).with_truncation(&truncation)
}

fn clamp_line(line: &str) -> String {
    if line.len() <= GREP_MAX_LINE_LENGTH {
        return line.to_string();
    }
    let mut end = GREP_MAX_LINE_LENGTH;
    while !line.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &line[..end])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-search-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/main.rs"), "fn main() {\n    todo!();\n}\n").unwrap();
        std::fs::write(dir.join("src/lib.rs"), "pub fn helper() {}\n").unwrap();
        std::fs::write(dir.join("notes.txt"), "todo: write docs\n").unwrap();
        dir
    }

    #[test]
    fn grep_reports_path_and_line_number() {
        let dir = fixture("grep");
        let result = grep(&json!({"pattern": "todo"}), &dir);
        assert!(!result.is_error);
        assert!(result.text.contains("main.rs:2:"));
    }

    #[test]
    fn grep_can_ignore_case_and_filter_by_glob() {
        let dir = fixture("grep-glob");
        let result = grep(
            &json!({"pattern": "TODO", "ignoreCase": true, "glob": "*.txt"}),
            &dir,
        );
        assert!(result.text.contains("notes.txt"));
        assert!(!result.text.contains("main.rs"));
    }

    #[test]
    fn grep_literal_mode_escapes_regex_metacharacters() {
        let dir = fixture("grep-literal");
        std::fs::write(dir.join("re.txt"), "a+b\n").unwrap();
        assert!(grep(&json!({"pattern": "a+b", "literal": true}), &dir)
            .text
            .contains("re.txt"));
    }

    #[test]
    fn grep_without_matches_says_so() {
        let dir = fixture("grep-none");
        assert_eq!(
            grep(&json!({"pattern": "zzz"}), &dir).text,
            "No matches found"
        );
    }

    #[test]
    fn grep_rejects_invalid_regex() {
        let dir = fixture("grep-bad");
        assert!(grep(&json!({"pattern": "("}), &dir).is_error);
    }

    #[test]
    fn find_matches_globs_and_returns_relative_paths() {
        let dir = fixture("find");
        assert_eq!(
            find(&json!({"pattern": "**/*.rs"}), &dir).text,
            "src/lib.rs\nsrc/main.rs"
        );
    }

    #[test]
    fn find_without_hits_says_so() {
        let dir = fixture("find-none");
        assert_eq!(
            find(&json!({"pattern": "**/*.py"}), &dir).text,
            "No files found matching pattern"
        );
    }

    #[test]
    fn long_lines_are_clamped() {
        let line = "x".repeat(GREP_MAX_LINE_LENGTH + 50);
        let clamped = clamp_line(&line);
        assert!(clamped.len() < line.len());
        assert!(clamped.ends_with('…'));
    }
}
