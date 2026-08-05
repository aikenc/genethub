//! Directory listing and file read/write, scoped to a workspace.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
#[cfg(not(unix))]
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use genehub_proto::{FileContent, FileNode, ResourceContent, ResourceMeta};

/// Beyond this a file is served truncated: the editor cannot usefully show
/// more, and shipping it wastes the link.
const MAX_READ_BYTES: usize = 2 * 1024 * 1024;
/// The resource contract exists specifically to serve binary content
/// `file::read` refuses, so its ceiling is generous rather than
/// editor-sized — big enough for a real screenshot or a short data export,
/// small enough that a client cannot use it to pull a multi-gigabyte file
/// through a single JSON envelope. `surface-and-inline.md` §2.2 keeps
/// anything larger behind an explicit "open" action rather than fetching it
/// implicitly, so this ceiling only bounds a request a person already made.
const MAX_RESOURCE_READ_BYTES: usize = 20 * 1024 * 1024;
const MAX_ENTRIES_PER_DIR: usize = 2000;
const MAX_TREE_NODES: usize = 10_000;

/// Builds a tree rooted at `path`, descending `depth` levels.
///
/// Depth is bounded because a workspace can contain a `node_modules` or a
/// `target` with a hundred thousand files, and a client asking for "the tree"
/// should not be able to stall the daemon.
pub fn tree(root: &Path, path: &Path, depth: u32) -> Result<FileNode> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    let mut remaining = MAX_TREE_NODES;
    tree_in(&directory, &relative, depth, &mut remaining)
}

fn tree_in(
    directory: &Dir,
    relative: &Path,
    depth: u32,
    remaining: &mut usize,
) -> Result<FileNode> {
    if *remaining == 0 {
        anyhow::bail!("file tree exceeded the node safety limit");
    }
    *remaining -= 1;
    let display_path = relative.to_string_lossy().replace('\\', "/");
    // `strip_prefix(root)` represents the root itself as an empty path, while
    // capability-relative filesystem APIs spell that directory `.`.
    let capability_path = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        relative
    };
    let name = relative
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string());

    let metadata = directory
        .metadata(capability_path)
        .with_context(|| format!("reading {}", relative.display()))?;
    if !metadata.is_dir() {
        return Ok(FileNode {
            name,
            path: display_path,
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
        let mut listing: Vec<_> = directory
            .read_dir(capability_path)
            .with_context(|| format!("listing {}", relative.display()))?
            .flatten()
            .collect();
        listing.sort_by_key(|entry| entry.file_name());

        for entry in listing.into_iter().take(MAX_ENTRIES_PER_DIR) {
            if *remaining == 0 {
                break;
            }
            let entry_path = relative.join(entry.file_name());
            if is_noise(&entry_path) {
                continue;
            }
            match tree_in(directory, &entry_path, depth.saturating_sub(1), remaining) {
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
        path: display_path,
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
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    let file = directory
        .open(&relative)
        .with_context(|| format!("reading {}", relative.display()))?;
    let size = file.metadata()?.len();
    let mut bytes = Vec::with_capacity(
        usize::try_from(size)
            .unwrap_or(MAX_READ_BYTES + 1)
            .min(MAX_READ_BYTES + 1),
    );
    file.into_std()
        .take((MAX_READ_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let relative = relative.to_string_lossy().replace('\\', "/");

    if looks_binary(&bytes) {
        return Ok(FileContent {
            path: relative,
            content: format!("Binary file, {size} bytes"),
            truncated: false,
            is_text: false,
        });
    }

    let truncated = size > MAX_READ_BYTES as u64 || bytes.len() > MAX_READ_BYTES;
    let slice = if truncated {
        // Cut on a character boundary so the result is still valid UTF-8.
        // A continuation byte is 0b10xxxxxx; back up until the cut lands on the
        // start of a character.
        let mut end = bytes.len().min(MAX_READ_BYTES);
        while end > 0 && end < bytes.len() && (bytes[end] & 0b1100_0000) == 0b1000_0000 {
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

/// Metadata for a resource, without reading its bytes.
pub fn stat(root: &Path, path: &Path) -> Result<ResourceMeta> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    let capability_path = if relative.as_os_str().is_empty() {
        Path::new(".")
    } else {
        &relative
    };
    let metadata = directory
        .metadata(capability_path)
        .with_context(|| format!("stat {}", relative.display()))?;
    let display_path = relative.to_string_lossy().replace('\\', "/");
    Ok(ResourceMeta {
        mime: guess_mime(&display_path),
        path: display_path,
        size: metadata.len(),
        is_dir: metadata.is_dir(),
    })
}

/// Every byte of a resource, base64-encoded — the read `file::read` refuses
/// once it decides a file is binary. See `MAX_RESOURCE_READ_BYTES` for the
/// ceiling and why it differs from the editor's.
pub fn read_bytes(root: &Path, path: &Path) -> Result<ResourceContent> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    let file = directory
        .open(&relative)
        .with_context(|| format!("reading {}", relative.display()))?;
    let size = file.metadata()?.len();
    let mut bytes = Vec::with_capacity(
        usize::try_from(size)
            .unwrap_or(MAX_RESOURCE_READ_BYTES + 1)
            .min(MAX_RESOURCE_READ_BYTES + 1),
    );
    file.into_std()
        .take((MAX_RESOURCE_READ_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let truncated = bytes.len() > MAX_RESOURCE_READ_BYTES;
    if truncated {
        bytes.truncate(MAX_RESOURCE_READ_BYTES);
    }
    let display_path = relative.to_string_lossy().replace('\\', "/");
    Ok(ResourceContent {
        mime: guess_mime(&display_path),
        path: display_path,
        size,
        data_base64: BASE64.encode(&bytes),
        truncated,
    })
}

/// The daemon decides the MIME type from the file's name; it never trusts a
/// caller's claim (`docs/specs/resource-fabric.md` §7 red line). Falls back
/// to `application/octet-stream`, which every client already treats as "no
/// renderer, offer a download" rather than failing on an unrecognized type.
fn guess_mime(path: &str) -> String {
    mime_guess::from_path(path)
        .first_or_octet_stream()
        .to_string()
}

pub fn write(root: &Path, path: &Path, content: &str) -> Result<()> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    if let Some(parent) = relative.parent() {
        directory.create_dir_all(parent)?;
    }
    directory
        .write(&relative, content)
        .with_context(|| format!("writing {}", relative.display()))
}

/// Opens the registered workspace as a directory capability.
///
/// All later lookups are relative to the opened handle. `cap-std` resolves
/// every component without ever leaving that handle, including when another
/// process swaps a checked parent directory for a symlink between lookup and
/// open. A workspace root which is itself currently a symlink is rejected: a
/// saved root cannot silently be retargeted after registration.
fn workspace_dir(root: &Path) -> Result<Dir> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .with_context(|| format!("opening workspace root {}", root.display()))?;
        Ok(Dir::from_std_file(file))
    }

    #[cfg(not(unix))]
    {
        let metadata = std::fs::symlink_metadata(root)
            .with_context(|| format!("reading workspace root {}", root.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!("workspace root is a symbolic link");
        }
        Dir::open_ambient_dir(root, ambient_authority())
            .with_context(|| format!("opening workspace root {}", root.display()))
    }
}

fn workspace_relative(root: &Path, path: &Path) -> Result<PathBuf> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| anyhow::anyhow!("path escapes the workspace"))?
        .to_path_buf();
    for component in relative.components() {
        if matches!(
            component,
            std::path::Component::ParentDir
                | std::path::Component::RootDir
                | std::path::Component::Prefix(_)
        ) {
            anyhow::bail!("path escapes the workspace");
        }
    }
    Ok(relative)
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
    fn resource_read_returns_binary_bytes_that_file_read_refuses() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.png");
        let bytes = [0x89, b'P', b'N', b'G', 0, 1, 2, 3];
        std::fs::write(&path, bytes).unwrap();

        // The editor contract still refuses it...
        let via_file = read(dir.path(), &path).unwrap();
        assert!(!via_file.is_text);

        // ...but the resource contract hands back every byte, round-trippable.
        let content = read_bytes(dir.path(), &path).unwrap();
        assert_eq!(content.path, "a.png");
        assert_eq!(content.mime, "image/png");
        assert!(!content.truncated);
        assert_eq!(BASE64.decode(&content.data_base64).unwrap(), bytes);
    }

    #[test]
    fn resource_read_truncates_past_the_ceiling_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        std::fs::write(&path, vec![7u8; MAX_RESOURCE_READ_BYTES + 1000]).unwrap();
        let content = read_bytes(dir.path(), &path).unwrap();
        assert!(content.truncated);
        assert_eq!(content.size, (MAX_RESOURCE_READ_BYTES + 1000) as u64);
        assert_eq!(
            BASE64.decode(&content.data_base64).unwrap().len(),
            MAX_RESOURCE_READ_BYTES
        );
    }

    #[test]
    fn resource_stat_reports_size_and_mime_without_reading_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("report.md");
        std::fs::write(&path, "# hello").unwrap();
        let meta = stat(dir.path(), &path).unwrap();
        assert_eq!(meta.path, "report.md");
        assert_eq!(meta.size, 7);
        assert!(!meta.is_dir);
        assert_eq!(meta.mime, "text/markdown");
    }

    #[cfg(unix)]
    #[test]
    fn resource_read_cannot_escape_the_workspace_via_a_symlink() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.bin"), [1u8, 2, 3]).unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();

        let escaped = workspace.path().join("escape/secret.bin");
        assert!(read_bytes(workspace.path(), &escaped).is_err());
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
        write(dir.path(), &path, "hi").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hi");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_turn_a_workspace_read_into_an_arbitrary_file_read() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "host secret").unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();

        let escaped = workspace.path().join("escape/secret.txt");
        assert!(read(workspace.path(), &escaped).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_turn_a_workspace_write_into_host_file_overwrite() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("authorized_keys");
        std::fs::write(&victim, "original").unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();

        let escaped = workspace.path().join("escape/authorized_keys");
        assert!(write(workspace.path(), &escaped, "attacker key").is_err());
        assert_eq!(std::fs::read_to_string(victim).unwrap(), "original");
    }

    #[cfg(unix)]
    #[test]
    fn a_tree_does_not_follow_a_directory_symlink_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "host secret").unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();

        let node = tree(workspace.path(), workspace.path(), 2).unwrap();
        assert!(node
            .children
            .unwrap()
            .into_iter()
            .all(|child| child.name != "escape"));
    }

    #[cfg(unix)]
    #[test]
    fn a_registered_workspace_root_cannot_be_retargeted_with_a_symlink() {
        use std::os::unix::fs::symlink;

        let container = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = container.path().join("workspace");
        symlink(outside.path(), &root).unwrap();

        let error = write(&root, &root.join("authorized_keys"), "attacker key").unwrap_err();
        assert!(error.to_string().contains("workspace root"));
        assert!(!outside.path().join("authorized_keys").exists());
    }
}
