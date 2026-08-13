//! Directory listing, exact Preview reads, and writes scoped to a workspace.

use std::io::Read;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
#[cfg(not(unix))]
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use genehub_proto::FileNode;
use genehub_proto::{AssetPreviewKind, AssetPreviewMetadata};
use sha2::{Digest, Sha256};

const MAX_ENTRIES_PER_DIR: usize = 2000;
const MAX_TREE_NODES: usize = 10_000;

/// Builds a tree rooted at `path`, descending `depth` levels.
///
/// Depth is bounded because a workspace can contain a `node_modules` or a
/// `target` with a hundred thousand files, and a client asking for "the tree"
/// should not be able to stall the daemon.
pub fn tree(root: &Path, path: &Path, depth: u32) -> Result<FileNode> {
    tree_with_prefix(root, path, depth, "", None)
}

/// Builds a tree whose client-visible paths live under a virtual root segment.
///
/// The capability root stays the concrete folder. Only the names returned to
/// the client are prefixed, so a multi-root workspace never turns a virtual
/// path into ambient filesystem authority.
pub fn tree_with_prefix(
    root: &Path,
    path: &Path,
    depth: u32,
    path_prefix: &str,
    root_name: Option<&str>,
) -> Result<FileNode> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    let mut remaining = MAX_TREE_NODES;
    tree_in(
        &directory,
        &relative,
        depth,
        &mut remaining,
        path_prefix,
        root_name,
    )
}

fn tree_in(
    directory: &Dir,
    relative: &Path,
    depth: u32,
    remaining: &mut usize,
    path_prefix: &str,
    root_name: Option<&str>,
) -> Result<FileNode> {
    if *remaining == 0 {
        anyhow::bail!("file tree exceeded the node safety limit");
    }
    *remaining -= 1;
    let relative_display = relative.to_string_lossy().replace('\\', "/");
    let display_path = match (path_prefix.is_empty(), relative_display.is_empty()) {
        (true, _) => relative_display,
        (false, true) => path_prefix.to_string(),
        (false, false) => format!("{path_prefix}/{relative_display}"),
    };
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
        .or_else(|| root_name.map(str::to_string))
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
            match tree_in(
                directory,
                &entry_path,
                depth.saturating_sub(1),
                remaining,
                path_prefix,
                None,
            ) {
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

#[derive(Debug)]
pub struct PreviewFile {
    pub metadata: AssetPreviewMetadata,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PreviewFailure {
    NotFound,
    Forbidden,
    Unsupported,
    TooLarge { source_bytes: u64 },
    SourceChanged,
}

impl std::fmt::Display for PreviewFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => formatter.write_str("preview source was not found"),
            Self::Forbidden => formatter.write_str("preview path is outside its workspace"),
            Self::Unsupported => formatter.write_str("preview file type is unsupported"),
            Self::TooLarge { source_bytes } => write!(
                formatter,
                "preview source is {source_bytes} bytes, above the {} byte limit",
                genehub_proto::MAX_PREVIEW_SOURCE_BYTES
            ),
            Self::SourceChanged => formatter.write_str("preview source changed while it was read"),
        }
    }
}

impl std::error::Error for PreviewFailure {}

/// Reads one complete regular workspace file or returns a low-cardinality
/// preview failure. It never truncates, summarizes, probes, transforms, or
/// follows a stream-like special file.
pub fn preview(
    root: &Path,
    relative_path: &str,
) -> std::result::Result<PreviewFile, PreviewFailure> {
    validate_preview_path(relative_path)?;
    let directory = workspace_dir(root).map_err(|_| PreviewFailure::Forbidden)?;
    let relative = Path::new(relative_path);
    let file = directory.open(relative).map_err(map_preview_io)?;
    let before = file.metadata().map_err(map_preview_io)?;
    if !before.is_file() {
        return Err(PreviewFailure::Unsupported);
    }
    if before.len() > genehub_proto::MAX_PREVIEW_SOURCE_BYTES as u64 {
        return Err(PreviewFailure::TooLarge {
            source_bytes: before.len(),
        });
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.into_std()
        .take((genehub_proto::MAX_PREVIEW_SOURCE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(map_preview_io)?;
    if bytes.len() > genehub_proto::MAX_PREVIEW_SOURCE_BYTES {
        return Err(PreviewFailure::TooLarge {
            source_bytes: bytes.len() as u64,
        });
    }
    // A replacement or growth between stat and EOF must not turn the promised
    // complete file into a prefix. Length catches the portable, meaningful
    // race; hashing below makes the successful response version exact.
    if bytes.len() as u64 != before.len() {
        return Err(PreviewFailure::SourceChanged);
    }
    let (kind, media_type) = preview_type(relative, &bytes)?;
    let digest = Sha256::digest(&bytes);
    let version = digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(PreviewFile {
        metadata: AssetPreviewMetadata {
            kind,
            media_type: media_type.to_string(),
            source_bytes: bytes.len() as u64,
            version,
        },
        bytes,
    })
}

pub(crate) fn validate_preview_path(path: &str) -> std::result::Result<(), PreviewFailure> {
    if path.is_empty()
        || path.len() > 4096
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.starts_with("//")
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
        || path
            .split('/')
            .any(|part| part.contains(':') || part.ends_with('.') || part.ends_with(' '))
    {
        return Err(PreviewFailure::Forbidden);
    }
    Ok(())
}

fn map_preview_io(error: std::io::Error) -> PreviewFailure {
    match error.kind() {
        std::io::ErrorKind::NotFound => PreviewFailure::NotFound,
        std::io::ErrorKind::PermissionDenied => PreviewFailure::Forbidden,
        _ => PreviewFailure::Unsupported,
    }
}

fn preview_type(
    path: &Path,
    bytes: &[u8],
) -> std::result::Result<(AssetPreviewKind, &'static str), PreviewFailure> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let exact = match extension.as_str() {
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => {
            Some((AssetPreviewKind::Image, "image/png"))
        }
        "jpg" | "jpeg" if bytes.starts_with(b"\xff\xd8\xff") => {
            Some((AssetPreviewKind::Image, "image/jpeg"))
        }
        "gif" if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") => {
            Some((AssetPreviewKind::Image, "image/gif"))
        }
        "webp" if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" => {
            Some((AssetPreviewKind::Image, "image/webp"))
        }
        "mp4" if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" => {
            Some((AssetPreviewKind::Video, "video/mp4"))
        }
        "webm" if bytes.starts_with(b"\x1a\x45\xdf\xa3") => {
            Some((AssetPreviewKind::Video, "video/webm"))
        }
        _ => None,
    };
    if let Some(found) = exact {
        return Ok(found);
    }

    let text = std::str::from_utf8(bytes).map_err(|_| PreviewFailure::Unsupported)?;
    if text.contains('\0') {
        return Err(PreviewFailure::Unsupported);
    }
    match extension.as_str() {
        "md" | "markdown" | "mdown" => Ok((AssetPreviewKind::Markdown, "text/markdown")),
        "html" | "htm" => Ok((AssetPreviewKind::Html, "text/html")),
        // A text document is a property of its bytes, not of whether this
        // release happened to know its suffix. The browser infers a language
        // when it can and safely falls back to escaped plain text when it
        // cannot; valid UTF-8 without NUL is therefore always previewable.
        _ => Ok((AssetPreviewKind::Text, "text/plain")),
    }
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

/// Creates a directory (and missing parents) inside the workspace capability.
pub fn mkdir(root: &Path, path: &Path) -> Result<()> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    if relative.as_os_str().is_empty() {
        anyhow::bail!("cannot create the workspace root");
    }
    if entry_exists(&directory, &relative)? {
        anyhow::bail!("{} already exists", relative.display());
    }
    directory
        .create_dir_all(&relative)
        .with_context(|| format!("creating {}", relative.display()))
}

/// Deletes a file or directory tree inside the workspace capability.
pub fn delete_path(root: &Path, path: &Path) -> Result<()> {
    let directory = workspace_dir(root)?;
    let relative = workspace_relative(root, path)?;
    if relative.as_os_str().is_empty() {
        anyhow::bail!("cannot delete the workspace root");
    }
    let metadata = directory
        .symlink_metadata(&relative)
        .with_context(|| format!("reading {}", relative.display()))?;
    if metadata.is_dir() {
        directory
            .remove_dir_all(&relative)
            .with_context(|| format!("deleting {}", relative.display()))
    } else {
        directory
            .remove_file(&relative)
            .with_context(|| format!("deleting {}", relative.display()))
    }
}

/// Moves or renames a path inside the same workspace root.
pub fn move_path(root: &Path, from: &Path, to: &Path) -> Result<()> {
    let directory = workspace_dir(root)?;
    let from_rel = workspace_relative(root, from)?;
    let to_rel = workspace_relative(root, to)?;
    validate_transfer(&from_rel, &to_rel)?;
    if entry_exists(&directory, &to_rel)? {
        anyhow::bail!("{} already exists", to_rel.display());
    }
    if let Some(parent) = to_rel.parent() {
        if !parent.as_os_str().is_empty() {
            directory.create_dir_all(parent)?;
        }
    }
    directory
        .rename(&from_rel, &directory, &to_rel)
        .with_context(|| format!("moving {} → {}", from_rel.display(), to_rel.display()))
}

/// Copies a file or directory tree inside the same workspace root.
pub fn copy_path(root: &Path, from: &Path, to: &Path) -> Result<()> {
    let directory = workspace_dir(root)?;
    let from_rel = workspace_relative(root, from)?;
    let to_rel = workspace_relative(root, to)?;
    validate_transfer(&from_rel, &to_rel)?;
    if entry_exists(&directory, &to_rel)? {
        anyhow::bail!("{} already exists", to_rel.display());
    }
    copy_recursive(&directory, &from_rel, &to_rel)
}

fn validate_transfer(from: &Path, to: &Path) -> Result<()> {
    if from.as_os_str().is_empty() || to.as_os_str().is_empty() {
        anyhow::bail!("cannot transfer the workspace root");
    }
    if to == from || to.starts_with(from) {
        anyhow::bail!("cannot place a path inside itself");
    }
    Ok(())
}

fn entry_exists(directory: &Dir, relative: &Path) -> Result<bool> {
    match directory.symlink_metadata(relative) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error).with_context(|| format!("reading {}", relative.display())),
    }
}

fn copy_recursive(directory: &Dir, from: &Path, to: &Path) -> Result<()> {
    let metadata = directory
        .symlink_metadata(from)
        .with_context(|| format!("reading {}", from.display()))?;
    if metadata.is_symlink() {
        anyhow::bail!("refusing to copy a symbolic link: {}", from.display());
    }
    if metadata.is_file() {
        if let Some(parent) = to.parent() {
            if !parent.as_os_str().is_empty() {
                directory.create_dir_all(parent)?;
            }
        }
        directory
            .copy(from, directory, to)
            .with_context(|| format!("copying {} → {}", from.display(), to.display()))?;
        return Ok(());
    }
    if metadata.is_dir() {
        directory
            .create_dir_all(to)
            .with_context(|| format!("creating {}", to.display()))?;
        for entry in directory
            .read_dir(from)
            .with_context(|| format!("listing {}", from.display()))?
            .flatten()
        {
            let name = entry.file_name();
            copy_recursive(directory, &from.join(&name), &to.join(&name))?;
        }
        return Ok(());
    }
    anyhow::bail!("unsupported file type: {}", from.display())
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
    fn writing_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a/b/c.txt");
        write(dir.path(), &path, "hi").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "hi");
    }

    #[test]
    fn mkdir_copy_move_and_delete_stay_inside_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        mkdir(dir.path(), &dir.path().join("src/assets")).unwrap();
        std::fs::write(dir.path().join("src/assets/note.txt"), "keep").unwrap();

        copy_path(
            dir.path(),
            &dir.path().join("src/assets"),
            &dir.path().join("src/assets-copy"),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("src/assets-copy/note.txt")).unwrap(),
            "keep"
        );

        move_path(
            dir.path(),
            &dir.path().join("src/assets-copy"),
            &dir.path().join("media"),
        )
        .unwrap();
        assert!(!dir.path().join("src/assets-copy").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("media/note.txt")).unwrap(),
            "keep"
        );

        delete_path(dir.path(), &dir.path().join("media")).unwrap();
        assert!(!dir.path().join("media").exists());
        assert!(dir.path().join("src/assets/note.txt").exists());
    }

    #[test]
    fn preview_returns_the_complete_four_megabyte_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![b'x'; genehub_proto::MAX_PREVIEW_SOURCE_BYTES];
        std::fs::write(dir.path().join("exact.txt"), &bytes).unwrap();
        let shown = preview(dir.path(), "exact.txt").unwrap();
        assert_eq!(shown.bytes, bytes);
        assert_eq!(shown.metadata.kind, AssetPreviewKind::Text);
        assert_eq!(shown.metadata.source_bytes, 4_194_304);

        std::fs::write(
            dir.path().join("large.txt"),
            vec![b'x'; genehub_proto::MAX_PREVIEW_SOURCE_BYTES + 1],
        )
        .unwrap();
        assert_eq!(
            preview(dir.path(), "large.txt").unwrap_err(),
            PreviewFailure::TooLarge {
                source_bytes: 4_194_305
            }
        );
    }

    #[test]
    fn preview_uses_magic_for_binary_types_and_utf8_for_documents() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("page.md"), "# 结果\n").unwrap();
        assert_eq!(
            preview(dir.path(), "page.md").unwrap().metadata.kind,
            AssetPreviewKind::Markdown
        );
        std::fs::write(dir.path().join("page.html"), "<script>ok()</script>").unwrap();
        assert_eq!(
            preview(dir.path(), "page.html").unwrap().metadata.kind,
            AssetPreviewKind::Html
        );
        std::fs::write(dir.path().join("fake.png"), b"not a png").unwrap();
        assert_eq!(
            preview(dir.path(), "fake.png").unwrap().metadata.kind,
            AssetPreviewKind::Text
        );
        std::fs::write(dir.path().join("real.png"), b"\x89PNG\r\n\x1a\nrest").unwrap();
        assert_eq!(
            preview(dir.path(), "real.png").unwrap().metadata.media_type,
            "image/png"
        );
        std::fs::write(
            dir.path().join("build.custom-language"),
            "target all:\n\tcompile --safe\n",
        )
        .unwrap();
        assert_eq!(
            preview(dir.path(), "build.custom-language")
                .unwrap()
                .metadata
                .kind,
            AssetPreviewKind::Text
        );
        std::fs::write(dir.path().join("binary.custom"), b"prefix\0suffix").unwrap();
        assert_eq!(
            preview(dir.path(), "binary.custom").unwrap_err(),
            PreviewFailure::Unsupported
        );
        let mut late_nul = vec![b'a'; 9_000];
        late_nul.push(0);
        std::fs::write(dir.path().join("late-nul.custom"), late_nul).unwrap();
        assert_eq!(
            preview(dir.path(), "late-nul.custom").unwrap_err(),
            PreviewFailure::Unsupported
        );
    }

    #[test]
    fn preview_rejects_noncanonical_and_platform_escape_spelling() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("ok.txt"), "ok").unwrap();
        for path in [
            "",
            "/ok.txt",
            "../ok.txt",
            "a/../ok.txt",
            "a//ok.txt",
            "a\\ok.txt",
            "C:/ok.txt",
            "file.txt:secret",
            "./ok.txt",
        ] {
            assert_eq!(
                preview(dir.path(), path).unwrap_err(),
                PreviewFailure::Forbidden,
                "{path:?}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn preview_does_not_follow_a_symlink_outside_the_workspace() {
        use std::os::unix::fs::symlink;

        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.txt"), "host secret").unwrap();
        symlink(outside.path(), workspace.path().join("escape")).unwrap();
        assert!(matches!(
            preview(workspace.path(), "escape/secret.txt"),
            Err(PreviewFailure::Forbidden | PreviewFailure::NotFound | PreviewFailure::Unsupported)
        ));
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
