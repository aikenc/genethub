//! The seven core tools. Result text is what the model reads; `details` is
//! structured metadata the UI renders (for example `details.diff` for edits),
//! so both halves are part of the contract.

mod bash;
mod diff;
mod fs_tools;
mod search;

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Value};

pub const DEFAULT_MAX_LINES: usize = 2000;
pub const DEFAULT_MAX_BYTES: usize = 50 * 1024;
pub const GREP_MAX_LINE_LENGTH: usize = 500;

/// Everything a caller needs to explain a truncation to the user without
/// re-reading the source.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncationResult {
    #[serde(skip)]
    pub content: String,
    pub truncated: bool,
    pub truncated_by: Option<&'static str>,
    pub total_lines: usize,
    pub total_bytes: usize,
    pub output_lines: usize,
    pub output_bytes: usize,
    pub last_line_partial: bool,
    pub first_line_exceeds_limit: bool,
    pub max_lines: usize,
    pub max_bytes: usize,
}

impl TruncationResult {
    fn build(
        content: String,
        source: &str,
        max_lines: usize,
        max_bytes: usize,
        truncated_by: Option<&'static str>,
        last_line_partial: bool,
        first_line_exceeds_limit: bool,
    ) -> Self {
        TruncationResult {
            output_lines: line_count(&content),
            output_bytes: content.len(),
            total_lines: line_count(source),
            total_bytes: source.len(),
            truncated: truncated_by.is_some(),
            truncated_by,
            last_line_partial,
            first_line_exceeds_limit,
            max_lines,
            max_bytes,
            content,
        }
    }
}

pub struct ToolResult {
    pub text: String,
    pub details: Option<Value>,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(text: impl Into<String>) -> Self {
        ToolResult {
            text: text.into(),
            details: None,
            is_error: false,
        }
    }

    /// Failures still carry an (empty) details object so consumers can treat
    /// `details` as always-present on errors.
    pub fn error(text: impl Into<String>) -> Self {
        ToolResult {
            text: text.into(),
            details: Some(json!({})),
            is_error: true,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    /// Only attach truncation info when something was actually cut; a clean
    /// result carries no `details` at all.
    pub fn with_truncation(self, truncation: &TruncationResult) -> Self {
        if !truncation.truncated {
            return self;
        }
        let value = serde_json::to_value(truncation).unwrap_or(Value::Null);
        self.with_details(json!({ "truncation": value }))
    }
}

/// JSON Schema definitions handed to the model. Anthropic and OpenAI both
/// accept plain JSON Schema, so one description serves both.
pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "read",
            "description": format!("Read the contents of a file. Output is truncated to {DEFAULT_MAX_LINES} lines or {}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.", DEFAULT_MAX_BYTES / 1024),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to the file to read (relative or absolute)" },
                    "offset": { "type": "number", "description": "Line number to start reading from (1-indexed)" },
                    "limit": { "type": "number", "description": "Maximum number of lines to read" }
                },
                "required": ["path"]
            }
        }),
        json!({
            "name": "write",
            "description": "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to the file to write (relative or absolute)" },
                    "content": { "type": "string", "description": "Content to write to the file" }
                },
                "required": ["path", "content"]
            }
        }),
        json!({
            "name": "edit",
            "description": "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Path to the file to edit (relative or absolute)" },
                    "edits": {
                        "type": "array",
                        "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "oldText": { "type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
                                "newText": { "type": "string", "description": "Replacement text for this targeted edit." }
                            },
                            "required": ["oldText", "newText"]
                        }
                    }
                },
                "required": ["path", "edits"]
            }
        }),
        json!({
            "name": "ls",
            "description": format!("List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to {} entries or {}KB (whichever is hit first).", fs_tools::LS_DEFAULT_LIMIT, DEFAULT_MAX_BYTES / 1024),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": { "type": "string", "description": "Directory to list (default: current directory)" },
                    "limit": { "type": "number", "description": "Maximum number of entries to return (default: 500)" }
                }
            }
        }),
        json!({
            "name": "grep",
            "description": format!("Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to {} matches or {}KB (whichever is hit first). Long lines are truncated to {GREP_MAX_LINE_LENGTH} chars.", search::GREP_DEFAULT_LIMIT, DEFAULT_MAX_BYTES / 1024),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Search pattern (regex or literal string)" },
                    "path": { "type": "string", "description": "Directory or file to search (default: current directory)" },
                    "glob": { "type": "string", "description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
                    "ignoreCase": { "type": "boolean", "description": "Case-insensitive search (default: false)" },
                    "literal": { "type": "boolean", "description": "Treat pattern as literal string instead of regex (default: false)" },
                    "context": { "type": "number", "description": "Number of lines to show before and after each match (default: 0)" },
                    "limit": { "type": "number", "description": "Maximum number of matches to return (default: 100)" }
                },
                "required": ["pattern"]
            }
        }),
        json!({
            "name": "find",
            "description": format!("Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to {} results or {}KB (whichever is hit first).", search::FIND_DEFAULT_LIMIT, DEFAULT_MAX_BYTES / 1024),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": { "type": "string", "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
                    "path": { "type": "string", "description": "Directory to search in (default: current directory)" },
                    "limit": { "type": "number", "description": "Maximum number of results (default: 1000)" }
                },
                "required": ["pattern"]
            }
        }),
        json!({
            "name": "bash",
            "description": format!("Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last {DEFAULT_MAX_LINES} lines or {}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.", DEFAULT_MAX_BYTES / 1024),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "Bash command to execute" },
                    "timeout": { "type": "number", "description": "Timeout in seconds (optional, no default timeout)" }
                },
                "required": ["command"]
            }
        }),
    ]
}

pub async fn execute(name: &str, args: &Value, cwd: &Path) -> ToolResult {
    match name {
        "read" => fs_tools::read(args, cwd),
        "write" => fs_tools::write(args, cwd),
        "edit" => fs_tools::edit(args, cwd),
        "ls" => fs_tools::ls(args, cwd),
        "grep" => search::grep(args, cwd),
        "find" => search::find(args, cwd),
        "bash" => bash::run(args, cwd).await,
        other => ToolResult::error(format!("Tool {other} not found")),
    }
}

pub fn resolve_path(cwd: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        cwd.join(path)
    }
}

pub fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)?.as_str().map(|s| s.to_string())
}

pub fn arg_usize(args: &Value, key: &str) -> Option<usize> {
    let value = args.get(key)?;
    value
        .as_u64()
        .or_else(|| value.as_f64().map(|f| f as u64))
        .map(|v| v as usize)
}

pub fn arg_bool(args: &Value, key: &str) -> bool {
    args.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

fn line_count(content: &str) -> usize {
    if content.is_empty() {
        return 0;
    }
    content.lines().count()
}

/// Keeps the head of the output; used by everything except bash.
pub fn truncate_head(source: &str, max_lines: usize, max_bytes: usize) -> TruncationResult {
    let lines: Vec<&str> = source.lines().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut bytes = 0usize;
    let mut truncated_by = None;
    let mut first_line_exceeds_limit = false;

    for (index, line) in lines.iter().enumerate() {
        if index >= max_lines {
            truncated_by = Some("lines");
            break;
        }
        let projected = bytes + line.len() + usize::from(index > 0);
        if projected > max_bytes {
            truncated_by = Some("bytes");
            first_line_exceeds_limit = index == 0;
            break;
        }
        bytes = projected;
        kept.push(line);
    }

    TruncationResult::build(
        kept.join("\n"),
        source,
        max_lines,
        max_bytes,
        truncated_by,
        false,
        first_line_exceeds_limit,
    )
}

/// Keeps the tail; what you want for command logs.
pub fn truncate_tail(source: &str, max_lines: usize, max_bytes: usize) -> TruncationResult {
    let lines: Vec<&str> = source.lines().collect();
    let mut start = 0usize;
    let mut truncated_by = None;

    if lines.len() > max_lines {
        start = lines.len() - max_lines;
        truncated_by = Some("lines");
    }

    let mut kept = lines[start..].join("\n");
    while kept.len() > max_bytes && start < lines.len() {
        start += 1;
        truncated_by = Some("bytes");
        kept = lines[start..].join("\n");
    }

    TruncationResult::build(
        kept,
        source,
        max_lines,
        max_bytes,
        truncated_by,
        false,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_definition_has_a_dispatch_arm() {
        let names: Vec<String> = definitions()
            .iter()
            .map(|d| d["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names.len(), 7);
        for name in ["read", "write", "edit", "ls", "grep", "find", "bash"] {
            assert!(names.contains(&name.to_string()), "missing {name}");
        }
    }

    #[test]
    fn head_truncation_reports_which_limit_was_hit() {
        let text = (1..=10)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let result = truncate_head(&text, 3, DEFAULT_MAX_BYTES);
        assert_eq!(result.content, "1\n2\n3");
        assert!(result.truncated);
        assert_eq!(result.truncated_by, Some("lines"));
        assert_eq!(result.total_lines, 10);
        assert_eq!(result.output_lines, 3);

        let byte_limited = truncate_head(&text, 100, 5);
        assert_eq!(byte_limited.truncated_by, Some("bytes"));
    }

    #[test]
    fn untruncated_output_is_marked_as_such() {
        let result = truncate_head("a\nb", DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert!(!result.truncated);
        assert_eq!(result.truncated_by, None);
        assert_eq!(result.content, "a\nb");
    }

    #[test]
    fn tail_truncation_keeps_the_last_lines() {
        let text = (1..=10)
            .map(|i| i.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        let result = truncate_tail(&text, 3, DEFAULT_MAX_BYTES);
        assert_eq!(result.content, "8\n9\n10");
        assert_eq!(result.truncated_by, Some("lines"));
    }

    #[test]
    fn truncation_details_are_only_attached_when_truncated() {
        let clean = truncate_head("a", DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES);
        assert!(ToolResult::ok("a")
            .with_truncation(&clean)
            .details
            .is_none());

        let cut = truncate_head("a\nb\nc", 1, DEFAULT_MAX_BYTES);
        let details = ToolResult::ok("a").with_truncation(&cut).details.unwrap();
        assert_eq!(details["truncation"]["truncatedBy"], "lines");
        assert_eq!(details["truncation"]["totalLines"], 3);
        assert!(details["truncation"].get("content").is_none());
    }

    #[test]
    fn errors_carry_an_empty_details_object_like_pi() {
        let result = ToolResult::error("boom");
        assert!(result.is_error);
        assert_eq!(result.details.unwrap(), json!({}));
    }

    #[test]
    fn relative_paths_resolve_against_cwd() {
        assert_eq!(
            resolve_path(Path::new("/work"), "src/main.rs"),
            Path::new("/work/src/main.rs")
        );
        assert_eq!(
            resolve_path(Path::new("/work"), "/etc/hosts"),
            Path::new("/etc/hosts")
        );
    }
}
