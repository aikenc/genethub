//! Directory listing and file read/write, scoped to a workspace.

use std::path::Path;

use anyhow::{Context, Result};
use genehub_proto::{FileContent, FileNode};

/// Beyond this a file is served truncated: the editor cannot usefully show
/// more, and shipping it wastes the link.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
const MAX_ENTRIES_PER_DIR: usize = 2000;

/// Builds a tree rooted at `path`, descending `depth` levels.
///
/// Depth is bounded because a workspace can contain a `node_modules` or a
/// `target` with a hundred thousand files, and a client asking for "the tree"
/// should not be able to stall the daemon.
pub fn tree(root: &Path, path: &Path, depth: u32) -> Result<FileNode> {
    let relative = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let metadata = std::fs::metadata(path)
        .with_context(|| format!("reading {}", path.display()))?;
    if !metadata.is_dir() {
        return Ok(FileNode {
            name,
            path: relative,
            is_dir: false,
            size: Some(metadata.len()),
            children: None,
        });
    }

    let children = if depth == 0 {
        // Absent children means "not expanded", which the client renders as a
        // collapsed folder rather than an empty one.
        None
    } else {
        let mut entries: Vec<FileNode> = Vec::new();
        let mut listing: Vec<_> = std::fs::read_dir(path)
            .with_context(|| format!("listing {}", path.display()))?
            .flatten()
            .collect();
        listing.sort_by_key(|entry| entry.file_name());

        for entry in listing.into_iter().take(MAX_ENTRIES_PER_DIR) {
            let entry_path = entry.path();
            if is_noise(&entry_path) {
                continue;
            }
            match tree(root, &entry_path, depth.saturating_sub(1)) {
                Ok(node) => entries.push(node),
                // A file that vanished or cannot be stat'd should not fail the
                // whole listing.
                Err(error) => tracing::debug!("skipping {}: {error}", entry_path.display()),
            }
        }
        // Directories first, then files, each alphabetically.
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        Some(entries)
    };

    Ok(FileNode {
        name,
        path: relative,
        is_dir: true,
        size: None,
        children,
    })
}

/// Directories that are always noise in a workspace tree.
fn is_noise(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|n| n.to_str()),
        Some(".git" | "node_modules" | "target" | ".venv" | "__pycache__" | ".DS_Store")
    )
}

pub fn read(root: &Path, path: &Path) -> Result<FileContent> {
    let relative = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.display().to_string());
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;

    if looks_binary(&bytes) {
        return Ok(FileContent {
            path: relative,
            content: format!("Binary file, {} bytes", bytes.len()),
            truncated: false,
            is_text: false,
        });
    }

    let truncated = bytes.len() > MAX_READ_BYTES;
    let slice = if truncated {
        // Cut on a character boundary so the result is still valid UTF-8.
        // A continuation byte is 0b10xxxxxx; back up until the cut lands on the
        // start of a character.
        let mut end = MAX_READ_BYTES;
        while end > 0 && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
            end -= 1;
        }
        &bytes[..end]
    } else {
        &bytes[..]
    };

    Ok(FileContent {
        path: relative,
        content: String::from_utf8_lossy(slice).to_string(),
        truncated,
        is_text: true,
    })
}

pub fn write(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, content).with_context(|| format!("writing {}", path.display()))
}

/// A NUL byte in the first block is the same heuristic git uses.
fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|byte| *byte == 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tree_puts_directories_first_and_hides_noise() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("z.txt"), "z").unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::create_dir(dir.path().join("node_modules")).unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();

        let node = tree(dir.path(), dir.path(), 1).unwrap();
        let children = node.children.unwrap();
        let names: Vec<_> = children.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, vec!["src", "a.txt", "z.txt"]);
    }

    #[test]
    fn depth_zero_returns_a_collapsed_directory_not_an_empty_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), "a").unwrap();
        let node = tree(dir.path(), dir.path(), 0).unwrap();
        assert!(
            node.children.is_none(),
            "an unexpanded folder must be distinguishable from an empty one"
        );
    }

    #[test]
    fn nested_paths_are_reported_relative_with_forward_slashes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("src/main.rs"), "fn main() {}").unwrap();

        let node = tree(dir.path(), dir.path(), 2).unwrap();
        let src = node
            .children
            .unwrap()
            .into_iter()
            .find(|c| c.name == "src")
            .unwrap();
        let main = &src.children.unwrap()[0];
        assert_eq!(main.path, "src/main.rs");
        assert_eq!(main.size, Some(12));
    }

    #[test]
    fn text_files_read_back_verbatim() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.txt");
        std::fs::write(&path, "hello\nworld").unwrap();
        let content = read(dir.path(), &path).unwrap();
        assert_eq!(content.content, "hello\nworld");
        assert!(content.is_text);
        assert!(!content.truncated);
        assert_eq!(content.path, "a.txt");
    }

    #[test]
    fn binary_files_are_flagged_rather_than_mangled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.bin");
        std::fs::write(&path, [0u8, 1, 2, 3]).unwrap();
        let content = read(dir.path(), &path).unwrap();
        assert!(!content.is_text);
        assert!(content.content.contains("Binary file"));
    }

    #[test]
    fn oversized_files_are_truncated_and_say_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        std::fs::write(&path, "x".repeat(MAX_READ_BYTES + 1000)).unwrap();
        let content = read(dir.path(), &path).unwrap();
        assert!(content.truncated);
        assert_eq!(content.content.len(), MAX_READ_BYTES);
    }

    /// Truncating mid-character would produce replacement characters at the
    /// cut, which looks like corruption to the user.
    #[test]
    fn truncation_does_not_split_a_multibyte_character() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("wide.txt");
        // Each of these is 3 bytes, so the limit lands mid-character.
        let text = "中".repeat(MAX_READ_BYTES);
        std::fs::write(&path, &text).unwrap();
        let content = read(dir.path(), &path).unwrap();
        assert!(content.truncated);
        assert!(!content.content.contains('\u{FFFD}'));
    }

    #[test]
    fn writing_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/c.txt");
        write(&path, "hi").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hi");
    }
}
