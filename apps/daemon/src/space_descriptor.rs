//! `agent-space.genet.json`: the one file that describes a project.
//!
//! GeneHub reads four things from it — `name`, `description`, `tags` and
//! `agentCwd` — and nothing else: every other key (`agents`, `skills`,
//! `skillProviders`, `children`, …) belongs to the Space builder and is
//! ignored here, so the file can grow without the daemon having to learn what
//! the keys mean. The descriptor is strict JSON, matching SpaceBuilder. A legacy
//! `.code-workspace` file can still use its existing JSON5 reader.
//!
//! The daemon never keeps what it reads. `agentCwd` is read again each time a
//! session starts, and the scan below looks at the directories again each time
//! it runs: the files are the truth, and a copy would be a second one.

use std::path::{Component, Path, PathBuf};

pub const FILE: &str = "agent-space.genet.json";
const MAX_BYTES: u64 = 256 * 1024;
/// Levels of child Spaces below a root that a scan follows: `spaces/<name>` and
/// `spaces/<name>/spaces/<name>`.
pub const MAX_NESTING: usize = 2;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Descriptor {
    pub name: Option<String>,
    pub description: Option<String>,
    pub tags: Vec<String>,
    /// Where a session starts when nothing says otherwise, relative to the
    /// Space. Always a safe relative path: absolute paths and `..` are refused
    /// when the file is read.
    pub agent_cwd: Option<String>,
    /// Optional path to the Space's own SpaceBuilder script, relative to the
    /// Space root. Always a safe relative path with no `..`.
    pub space_builder: Option<String>,
}

/// The descriptor in `dir`: `Ok(None)` when there is none, `Err` with what to
/// fix when there is one that cannot be used.
pub fn read(dir: &Path) -> Result<Option<Descriptor>, String> {
    let path = dir.join(FILE);
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("{FILE} cannot be read: {error}")),
    };
    if meta.file_type().is_symlink() {
        return Err(format!(
            "{FILE} is a symbolic link; write the file in place"
        ));
    }
    if !meta.is_file() || meta.len() > MAX_BYTES {
        return Err(format!(
            "{FILE} must be a regular file under {MAX_BYTES} bytes"
        ));
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|error| format!("{FILE} cannot be read: {error}"))?;
    parse(&text).map(Some)
}

pub fn parse(text: &str) -> Result<Descriptor, String> {
    let value: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("{FILE} is not valid JSON: {error}"))?;
    let Some(object) = value.as_object() else {
        return Err(format!("{FILE} must be one JSON object"));
    };
    let text_of = |key: &str| -> Result<Option<String>, String> {
        match object.get(key) {
            None | Some(serde_json::Value::Null) => Ok(None),
            Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
                Ok(Some(text.trim().to_string()))
            }
            Some(_) => Err(format!("\"{key}\" must be a non-empty string")),
        }
    };
    let tags = match object.get("tags") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| match item.as_str() {
                Some(tag) if !tag.trim().is_empty() => Ok(tag.trim().to_string()),
                _ => Err("\"tags\" must be a list of non-empty strings".to_string()),
            })
            .collect::<Result<Vec<_>, _>>()?,
        Some(_) => return Err("\"tags\" must be a list of strings".into()),
    };
    let agent_cwd = text_of("agentCwd")?;
    if let Some(cwd) = &agent_cwd {
        safe_relative_key("agentCwd", cwd)?;
    }
    let space_builder = text_of("spaceBuilder")?;
    if let Some(builder) = &space_builder {
        safe_relative_key("spaceBuilder", builder)?;
    }
    Ok(Descriptor {
        name: text_of("name")?,
        description: text_of("description")?,
        tags,
        agent_cwd,
        space_builder,
    })
}

/// The `folders` the descriptor declares, exactly as written (`{"path": …, "name": …}` objects), or `None` when
/// there is no usable descriptor or it declares none. This is the descriptor's replacement for a `.code-workspace`
/// file: the daemon opens the Space with these directories as its roots, in this order. Entries are not judged
/// here; the caller drops the ones this machine cannot use.
pub fn declared_folders(dir: &Path) -> Option<Vec<serde_json::Value>> {
    let path = dir.join(FILE);
    let meta = std::fs::symlink_metadata(&path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() || meta.len() > MAX_BYTES {
        return None;
    }
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).ok()?).ok()?;
    let folders = value.get("folders")?.as_array()?;
    (!folders.is_empty()).then(|| folders.clone())
}

/// A relative path that stays inside where it is joined: no root, no prefix, no
/// `..`. `.` segments are harmless and dropped.
fn safe_relative(text: &str) -> Result<PathBuf, String> {
    safe_relative_key("agentCwd", text)
}

fn safe_relative_key(key: &str, text: &str) -> Result<PathBuf, String> {
    let mut clean = PathBuf::new();
    for component in Path::new(text).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "\"{key}\" `{text}` must be a relative path inside the Space, with no `..`"
                ))
            }
        }
    }
    if clean.as_os_str().is_empty() {
        return Err(format!(
            "\"{key}\" names the Space itself; leave it out instead"
        ));
    }
    Ok(clean)
}

/// The directory a session in this Space starts in when nothing else is said:
/// the descriptor's `agentCwd` when it names a real directory inside the Space,
/// otherwise `None` and the Space root applies. A descriptor that is missing,
/// broken or points nowhere never prevents a session from starting.
pub fn agent_cwd(root: &Path) -> Option<PathBuf> {
    let descriptor = read(root).ok()??;
    let relative = safe_relative(descriptor.agent_cwd.as_deref()?).ok()?;
    let candidate = root.join(relative);
    // A symlink inside the Space must not carry a session out of it.
    let real = candidate.canonicalize().ok()?;
    let base = root.canonicalize().ok()?;
    (real.is_dir() && real.starts_with(&base)).then_some(candidate)
}

/// The Space's own `spaceBuilder` script when it names a real file inside the
/// Space, otherwise `None` and the caller falls back to the bundled script.
pub fn space_builder(root: &Path) -> Option<PathBuf> {
    let descriptor = read(root).ok()??;
    let relative = safe_relative_key("spaceBuilder", descriptor.space_builder.as_deref()?).ok()?;
    let candidate = root.join(relative);
    let real = candidate.canonicalize().ok()?;
    let base = root.canonicalize().ok()?;
    (real.is_file() && real.starts_with(&base)).then_some(candidate)
}

/// One Space found on disk, with the Spaces nested under it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Found {
    pub dir: PathBuf,
    pub descriptor: Descriptor,
    pub children: Vec<Found>,
}

#[derive(Debug, Default)]
pub struct Discovery {
    pub roots: Vec<Found>,
    /// Descriptors that exist but cannot be used, with the reason. A Space
    /// whose descriptor is broken is not a Space, and saying why beats
    /// silently not finding it.
    pub problems: Vec<String>,
}

/// Reads `dir` as a Space root and discovers any child Spaces nested under
/// `dir/spaces/*` (up to `MAX_NESTING`). Returns `Ok(None)` when `dir` has no
/// `agent-space.genet.json`.
pub fn discover_root(dir: &Path) -> Result<Option<Found>, String> {
    let Some(descriptor) = read(dir)? else {
        return Ok(None);
    };
    let mut problems = Vec::new();
    let children = children_of(dir, 1, &mut problems);
    for problem in &problems {
        tracing::warn!(%problem, "a child Space descriptor cannot be used");
    }
    Ok(Some(Found {
        dir: dir.to_path_buf(),
        descriptor,
        children,
    }))
}

/// Every root Space under `spaces_root`, and the Spaces nested in each.
///
/// A directory with a descriptor is a Space. A directory without one is a set:
/// the directories one level inside it that have descriptors are Spaces. That
/// is all the depth there is, so a scan never walks `node_modules` or a
/// worktree, and hidden directories and symbolic links are never entered.
pub fn discover(spaces_root: &Path) -> Discovery {
    let mut found = Discovery::default();
    for dir in subdirectories(spaces_root) {
        match read(&dir) {
            Ok(Some(descriptor)) => {
                let children = children_of(&dir, 1, &mut found.problems);
                found.roots.push(Found {
                    dir,
                    descriptor,
                    children,
                });
            }
            Ok(None) => {
                for inner in subdirectories(&dir) {
                    match read(&inner) {
                        Ok(Some(descriptor)) => {
                            let children = children_of(&inner, 1, &mut found.problems);
                            found.roots.push(Found {
                                dir: inner,
                                descriptor,
                                children,
                            });
                        }
                        Ok(None) => {}
                        Err(problem) => found
                            .problems
                            .push(format!("{}: {problem}", inner.display())),
                    }
                }
            }
            Err(problem) => found.problems.push(format!("{}: {problem}", dir.display())),
        }
    }
    found
}

fn children_of(dir: &Path, level: usize, problems: &mut Vec<String>) -> Vec<Found> {
    if level > MAX_NESTING {
        return Vec::new();
    }
    let mut children = Vec::new();
    for child in subdirectories(&dir.join("spaces")) {
        match read(&child) {
            Ok(Some(descriptor)) => {
                let nested = children_of(&child, level + 1, problems);
                children.push(Found {
                    dir: child,
                    descriptor,
                    children: nested,
                });
            }
            Ok(None) => {}
            Err(problem) => problems.push(format!("{}: {problem}", child.display())),
        }
    }
    children
}

/// Real, visible directories directly inside `dir`, by name. A missing
/// directory has none.
fn subdirectories(dir: &Path) -> Vec<PathBuf> {
    let Ok(reader) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs: Vec<PathBuf> = reader
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" {
                return None;
            }
            // `file_type` does not follow links, so a link to a directory is
            // not one here.
            entry.file_type().ok()?.is_dir().then(|| entry.path())
        })
        .collect();
    dirs.sort();
    dirs
}
