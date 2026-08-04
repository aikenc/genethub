//! read / write / edit / ls

use std::path::Path;

use serde_json::{json, Value};

use super::diff;
use super::{
    arg_str, arg_usize, resolve_path, truncate_head, ToolResult, DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
};

pub const LS_DEFAULT_LIMIT: usize = 500;

pub fn read(args: &Value, cwd: &Path) -> ToolResult {
    let Some(raw_path) = arg_str(args, "path") else {
        return ToolResult::error("read: 'path' is required");
    };
    let path = resolve_path(cwd, &raw_path);

    let content = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => return ToolResult::error(format!("Failed to read {}: {err}", path.display())),
    };

    let offset = arg_usize(args, "offset").unwrap_or(1).max(1);
    let limit = arg_usize(args, "limit").unwrap_or(DEFAULT_MAX_LINES);

    let selected = content
        .lines()
        .skip(offset - 1)
        .take(limit)
        .collect::<Vec<_>>()
        .join("\n");

    let truncation = truncate_head(&selected, limit.min(DEFAULT_MAX_LINES), DEFAULT_MAX_BYTES);
    ToolResult::ok(truncation.content.clone()).with_truncation(&truncation)
}

pub fn write(args: &Value, cwd: &Path) -> ToolResult {
    let Some(raw_path) = arg_str(args, "path") else {
        return ToolResult::error("write: 'path' is required");
    };
    let Some(content) = arg_str(args, "content") else {
        return ToolResult::error("write: 'content' is required");
    };
    let path = resolve_path(cwd, &raw_path);

    if let Some(parent) = path.parent() {
        if let Err(err) = std::fs::create_dir_all(parent) {
            return ToolResult::error(format!("Failed to create {}: {err}", parent.display()));
        }
    }
    if let Err(err) = std::fs::write(&path, &content) {
        return ToolResult::error(format!("Failed to write {}: {err}", path.display()));
    }

    ToolResult::ok(format!(
        "Successfully wrote {} bytes to {raw_path}",
        content.len()
    ))
}

/// Every `oldText` is matched against the original file, never against the
/// partially edited buffer, so overlapping edits are rejected rather than
/// silently applied in sequence.
pub fn edit(args: &Value, cwd: &Path) -> ToolResult {
    let Some(raw_path) = arg_str(args, "path") else {
        return ToolResult::error("edit: 'path' is required");
    };
    let Some(edits) = args.get("edits").and_then(|e| e.as_array()) else {
        return ToolResult::error("edit: 'edits' must be an array");
    };
    if edits.is_empty() {
        return ToolResult::error("edit: 'edits' must contain at least one edit");
    }
    let path = resolve_path(cwd, &raw_path);

    let original = match std::fs::read_to_string(&path) {
        Ok(content) => content,
        Err(err) => return ToolResult::error(format!("Failed to read {}: {err}", path.display())),
    };

    let mut replacements: Vec<(usize, usize, String)> = Vec::new();
    for (index, entry) in edits.iter().enumerate() {
        let (Some(old_text), Some(new_text)) =
            (arg_str(entry, "oldText"), arg_str(entry, "newText"))
        else {
            return ToolResult::error(format!(
                "edit: edits[{index}] requires both oldText and newText"
            ));
        };
        if old_text.is_empty() {
            return ToolResult::error(format!("edit: edits[{index}].oldText must not be empty"));
        }

        let matches: Vec<usize> = original
            .match_indices(&old_text)
            .map(|(at, _)| at)
            .collect();
        match matches.len() {
            0 => {
                return ToolResult::error(format!(
                    "edit: edits[{index}].oldText was not found in {raw_path}"
                ))
            }
            1 => {}
            count => {
                return ToolResult::error(format!(
                "edit: edits[{index}].oldText matches {count} times in {raw_path}; make it unique"
            ))
            }
        }

        let start = matches[0];
        let end = start + old_text.len();
        if let Some((other, _, _)) = replacements
            .iter()
            .find(|(other_start, other_end, _)| start < *other_end && *other_start < end)
        {
            return ToolResult::error(format!(
                "edit: edits[{index}].oldText overlaps another edit at byte {other}; merge them into one edit"
            ));
        }
        replacements.push((start, end, new_text));
    }

    let mut updated = original.clone();
    replacements.sort_by_key(|(start, _, _)| *start);
    for (start, end, new_text) in replacements.iter().rev() {
        updated.replace_range(start..end, new_text);
    }

    if let Err(err) = std::fs::write(&path, &updated) {
        return ToolResult::error(format!("Failed to write {}: {err}", path.display()));
    }

    let (diff_string, first_changed_line) = diff::generate_diff_string(&original, &updated);
    let patch = diff::generate_unified_patch(&raw_path, &original, &updated);

    ToolResult::ok(format!(
        "Successfully applied {} edit(s) to {raw_path}",
        edits.len()
    ))
    .with_details(json!({
        "diff": diff_string,
        "patch": patch,
        "firstChangedLine": first_changed_line,
    }))
}

pub fn ls(args: &Value, cwd: &Path) -> ToolResult {
    let path = match arg_str(args, "path") {
        Some(raw) => resolve_path(cwd, &raw),
        None => cwd.to_path_buf(),
    };
    let limit = arg_usize(args, "limit").unwrap_or(LS_DEFAULT_LIMIT);

    let entries = match std::fs::read_dir(&path) {
        Ok(entries) => entries,
        Err(err) => return ToolResult::error(format!("Failed to list {}: {err}", path.display())),
    };

    let mut names: Vec<String> = entries
        .flatten()
        .map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if entry.path().is_dir() {
                format!("{name}/")
            } else {
                name
            }
        })
        .collect();

    if names.is_empty() {
        return ToolResult::ok("(empty directory)");
    }

    names.sort();
    names.truncate(limit);

    // Entry count is already capped, so only the byte limit applies here.
    let truncation = truncate_head(&names.join("\n"), usize::MAX, DEFAULT_MAX_BYTES);
    ToolResult::ok(truncation.content.clone()).with_truncation(&truncation)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("genet-fs-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn write_then_read_round_trips() {
        let dir = temp_dir("roundtrip");
        let result = write(&json!({"path": "a/b.txt", "content": "hello"}), &dir);
        assert!(!result.is_error);
        assert_eq!(result.text, "Successfully wrote 5 bytes to a/b.txt");
        assert_eq!(read(&json!({"path": "a/b.txt"}), &dir).text, "hello");
    }

    #[test]
    fn absolute_paths_can_be_written_outside_the_working_directory() {
        let root = temp_dir("absolute-outside-cwd");
        let cwd = root.join("workspace");
        std::fs::create_dir_all(&cwd).unwrap();
        let outside = root.join("elsewhere/result.txt");

        let result = write(&json!({"path": outside, "content": "unrestricted"}), &cwd);
        assert!(!result.is_error, "{}", result.text);
        assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unrestricted");
        assert!(!outside.starts_with(&cwd));
    }

    #[test]
    fn read_honours_offset_and_limit() {
        let dir = temp_dir("offset");
        std::fs::write(dir.join("f.txt"), "l1\nl2\nl3\nl4\n").unwrap();
        let result = read(&json!({"path": "f.txt", "offset": 2, "limit": 2}), &dir);
        assert_eq!(result.text, "l2\nl3");
        assert!(result.details.is_none());
    }

    #[test]
    fn read_reports_missing_files_as_errors() {
        let dir = temp_dir("missing");
        let result = read(&json!({"path": "nope.txt"}), &dir);
        assert!(result.is_error);
        assert!(result.text.starts_with("Failed to read"));
    }

    #[test]
    fn edit_requires_a_unique_match() {
        let dir = temp_dir("edit-dup");
        std::fs::write(dir.join("f.txt"), "dup\ndup\n").unwrap();
        let result = edit(
            &json!({"path": "f.txt", "edits": [{"oldText": "dup", "newText": "x"}]}),
            &dir,
        );
        assert!(result.is_error);
        assert!(result.text.contains("matches 2 times"));
    }

    #[test]
    fn edits_match_against_the_original_file() {
        let dir = temp_dir("edit-original");
        std::fs::write(dir.join("f.txt"), "alpha\nbeta\n").unwrap();
        // The second edit targets text the first one would have destroyed if
        // edits were applied incrementally.
        let result = edit(
            &json!({"path": "f.txt", "edits": [
                {"oldText": "alpha", "newText": "beta"},
                {"oldText": "beta", "newText": "gamma"}
            ]}),
            &dir,
        );
        assert!(!result.is_error, "{}", result.text);
        assert_eq!(
            std::fs::read_to_string(dir.join("f.txt")).unwrap(),
            "beta\ngamma\n"
        );
    }

    #[test]
    fn overlapping_edits_are_rejected() {
        let dir = temp_dir("edit-overlap");
        std::fs::write(dir.join("f.txt"), "abcdef\n").unwrap();
        let result = edit(
            &json!({"path": "f.txt", "edits": [
                {"oldText": "abcd", "newText": "x"},
                {"oldText": "cdef", "newText": "y"}
            ]}),
            &dir,
        );
        assert!(result.is_error);
        assert!(result.text.contains("overlaps"));
    }

    #[test]
    fn edit_details_carry_diff_and_patch() {
        let dir = temp_dir("edit-details");
        std::fs::write(dir.join("f.txt"), "one\ntwo\n").unwrap();
        let result = edit(
            &json!({"path": "f.txt", "edits": [{"oldText": "two", "newText": "TWO"}]}),
            &dir,
        );
        let details = result.details.unwrap();
        assert!(details["diff"].as_str().unwrap().contains("+2 TWO"));
        assert!(details["patch"].as_str().unwrap().contains("--- f.txt"));
        assert_eq!(details["firstChangedLine"], 2);
    }

    #[test]
    fn ls_marks_directories_and_sorts() {
        let dir = temp_dir("ls");
        std::fs::create_dir(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.txt"), "").unwrap();
        assert_eq!(ls(&json!({}), &dir).text, "a.txt\nsub/");
    }

    #[test]
    fn empty_directories_say_so() {
        let dir = temp_dir("ls-empty");
        assert_eq!(ls(&json!({}), &dir).text, "(empty directory)");
    }
}
