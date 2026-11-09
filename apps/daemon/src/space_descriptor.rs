//! `agent-space.genet.json`: the one file that describes a project.
//!
//! GeneHub reads project metadata, `folders`, `agentCwd` and `spaceBuilder`.
//! Every other key (`agents`, `skills`,
//! `skillProviders`, `children`, …) belongs to the Space builder and is
//! ignored here, so the file can grow without the daemon having to learn what
//! the keys mean. The descriptor is strict JSON, matching SpaceBuilder. A legacy
//! `.code-workspace` file can still use its existing JSON5 reader.
//!
//! Files remain authoritative. Execution reads `agentCwd` again when a session
//! starts; discovery refreshes the derived member view used by workspace.list.
//! That presentation cache never replaces file validation at execution time.

use std::collections::{HashMap, HashSet};
use std::path::{Component, Path, PathBuf};

use crate::fs_stamp::Stamp;

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
    pub members: Vec<genehub_proto::SpaceMemberReference>,
    /// Where a session starts when nothing says otherwise, relative to the
    /// Space. Always a safe relative path: absolute paths and `..` are refused
    /// when the file is read.
    pub agent_cwd: Option<String>,
    /// Optional path to the Space's own SpaceBuilder script, relative to the
    /// Space root. Always a safe relative path with no `..`.
    pub space_builder: Option<String>,
    /// Raw declarations are resolved once per discovery pass, outside registry locks.
    pub folders: Vec<serde_json::Value>,
}

/// The descriptor in `dir`: `Ok(None)` when there is none, `Err` with what to
/// fix when there is one that cannot be used.
pub fn read(dir: &Path) -> Result<Option<Descriptor>, String> {
    let _work = crate::diagnostics::work::FileScope::new(
        crate::diagnostics::work::FileWork::SpaceDescriptor,
    );
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
    let members = match object.get("members") {
        None | Some(serde_json::Value::Null) => Vec::new(),
        Some(serde_json::Value::Array(items)) if items.len() <= 128 => {
            let mut seen = std::collections::HashSet::new();
            let mut names = std::collections::HashSet::new();
            let mut members = Vec::new();
            for item in items {
                let member: genehub_proto::SpaceMemberReference =
                    serde_json::from_value(item.clone()).map_err(|_| {
                        "members requires machineId and workspaceId strings".to_string()
                    })?;
                if [&member.machine_id, &member.workspace_id]
                    .iter()
                    .any(|id| id.trim().is_empty() || id.len() > 200 || id.trim() != id.as_str())
                    || member
                        .name
                        .as_ref()
                        .is_some_and(|name| name.trim().is_empty() || name.len() > 200)
                    || !seen.insert((member.machine_id.clone(), member.workspace_id.clone()))
                    || member
                        .name
                        .as_ref()
                        .is_some_and(|name| !names.insert(name.clone()))
                {
                    return Err("members contains invalid or duplicate Space references".into());
                }
                members.push(member);
            }
            members
        }
        Some(_) => return Err("members must be an array of at most 128 Space references".into()),
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
        members,
        agent_cwd,
        space_builder,
        folders: object
            .get("folders")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default(),
    })
}

/// Raw folders remain usable on explicit open even when unrelated descriptor
/// metadata is invalid. Normal discovery reuses the already parsed Descriptor.
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
pub async fn discover_root(dir: &Path) -> Result<Option<Found>, String> {
    let Some(descriptor) = read(dir)? else {
        return Ok(None);
    };
    let mut problems = Vec::new();
    let mut budget = crate::blocking::WorkBudget::new();
    let children = children_uncached(dir, 1, &mut problems, &mut budget).await;
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
pub async fn discover(spaces_root: &Path) -> Discovery {
    discover_cached(spaces_root, &mut DiscoveryCache::default(), true).await
}

/// How often discovery looks at one listing or descriptor again. The top of
/// the tree and its sets are looked at on every pass; inside a Space, at
/// least once per `cold`. Opening a Space registers it at once regardless.
const DISCOVERY_CADENCE: crate::fs_stamp::Cadence = crate::fs_stamp::Cadence {
    hot: std::time::Duration::from_secs(2),
    cold: std::time::Duration::from_secs(30),
    hot_for: std::time::Duration::from_secs(60),
};

type Parsed = Result<Option<Descriptor>, String>;

/// What discovery last saw, so a pass reads only what changed.
#[derive(Default)]
pub struct DiscoveryCache {
    listings: HashMap<PathBuf, (Option<Stamp>, Vec<PathBuf>, crate::fs_stamp::Watch)>,
    descriptors: HashMap<PathBuf, (Option<Stamp>, Parsed, crate::fs_stamp::Watch)>,
    /// A first pass is over: what appears after it was just deployed and is
    /// likely to be edited again soon, so it starts hot.
    primed: bool,
}

struct Pass<'a> {
    cache: &'a mut DiscoveryCache,
    force: bool,
    now: std::time::Instant,
    listings: HashSet<PathBuf>,
    descriptors: HashSet<PathBuf>,
}

impl Pass<'_> {
    fn first_watch(&self, path: &Path, stamp: Option<&Stamp>) -> crate::fs_stamp::Watch {
        if !self.cache.primed {
            return crate::fs_stamp::Watch::first(path, stamp, self.now, DISCOVERY_CADENCE);
        }
        let mut watch = crate::fs_stamp::Watch::now(self.now);
        watch.looked(stamp, true, self.now, DISCOVERY_CADENCE);
        watch
    }

    async fn subdirectories(
        &mut self,
        dir: &Path,
        always: bool,
        budget: &mut crate::blocking::WorkBudget,
    ) -> Vec<PathBuf> {
        self.listings.insert(dir.to_path_buf());
        let known = self.cache.listings.get(dir);
        if !self.force && !always {
            if let Some((_, listed, _)) = known.filter(|(_, _, watch)| !watch.due(self.now)) {
                return listed.clone();
            }
        }
        let stamp = Stamp::read(dir);
        if let Some((_, listed, _)) = known.filter(|(known, _, _)| {
            !self.force && *known == stamp && crate::fs_stamp::settled(known.as_ref())
        }) {
            let listed = listed.clone();
            if let Some((_, _, watch)) = self.cache.listings.get_mut(dir) {
                watch.looked(stamp.as_ref(), false, self.now, DISCOVERY_CADENCE);
            }
            return listed;
        }
        let listed = subdirectories(dir, budget).await;
        let watch = match self.cache.listings.remove(dir) {
            Some((_, _, mut watch)) => {
                watch.looked(stamp.as_ref(), true, self.now, DISCOVERY_CADENCE);
                watch
            }
            None => self.first_watch(dir, stamp.as_ref()),
        };
        self.cache
            .listings
            .insert(dir.to_path_buf(), (stamp, listed.clone(), watch));
        listed
    }

    fn read(&mut self, dir: &Path) -> Parsed {
        self.descriptors.insert(dir.to_path_buf());
        let known = self.cache.descriptors.get(dir);
        if !self.force {
            if let Some((_, parsed, _)) = known.filter(|(_, _, watch)| !watch.due(self.now)) {
                return parsed.clone();
            }
        }
        let stamp = Stamp::read_link(&dir.join(FILE));
        if let Some((_, parsed, _)) = known.filter(|(known, _, _)| {
            !self.force && *known == stamp && crate::fs_stamp::settled(known.as_ref())
        }) {
            let parsed = parsed.clone();
            if let Some((_, _, watch)) = self.cache.descriptors.get_mut(dir) {
                watch.looked(stamp.as_ref(), false, self.now, DISCOVERY_CADENCE);
            }
            return parsed;
        }
        let parsed = read(dir);
        let watch = match self.cache.descriptors.remove(dir) {
            Some((_, _, mut watch)) => {
                watch.looked(stamp.as_ref(), true, self.now, DISCOVERY_CADENCE);
                watch
            }
            None => self.first_watch(dir, stamp.as_ref()),
        };
        self.cache
            .descriptors
            .insert(dir.to_path_buf(), (stamp, parsed.clone(), watch));
        parsed
    }
}

/// [`discover`], reusing what `cache` saw for listings and descriptors whose
/// stamps did not change. `force` looks at everything again.
pub async fn discover_cached(
    spaces_root: &Path,
    cache: &mut DiscoveryCache,
    force: bool,
) -> Discovery {
    let mut pass = Pass {
        cache,
        force,
        now: std::time::Instant::now(),
        listings: HashSet::new(),
        descriptors: HashSet::new(),
    };
    let mut found = Discovery::default();
    let mut budget = crate::blocking::WorkBudget::new();
    for dir in pass.subdirectories(spaces_root, true, &mut budget).await {
        budget.checkpoint().await;
        match pass.read(&dir) {
            Ok(Some(descriptor)) => {
                let children =
                    children_of(&mut pass, &dir, 1, &mut found.problems, &mut budget).await;
                found.roots.push(Found {
                    dir,
                    descriptor,
                    children,
                });
            }
            Ok(None) => {
                for inner in pass.subdirectories(&dir, true, &mut budget).await {
                    budget.checkpoint().await;
                    match pass.read(&inner) {
                        Ok(Some(descriptor)) => {
                            let children =
                                children_of(&mut pass, &inner, 1, &mut found.problems, &mut budget)
                                    .await;
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
    let Pass {
        cache,
        listings,
        descriptors,
        ..
    } = pass;
    cache.listings.retain(|dir, _| listings.contains(dir));
    cache.descriptors.retain(|dir, _| descriptors.contains(dir));
    cache.primed = true;
    found
}

async fn children_of(
    pass: &mut Pass<'_>,
    dir: &Path,
    level: usize,
    problems: &mut Vec<String>,
    budget: &mut crate::blocking::WorkBudget,
) -> Vec<Found> {
    if level > MAX_NESTING {
        return Vec::new();
    }
    let mut children = Vec::new();
    for child in pass
        .subdirectories(&dir.join("spaces"), false, budget)
        .await
    {
        budget.checkpoint().await;
        match pass.read(&child) {
            Ok(Some(descriptor)) => {
                let nested = Box::pin(children_of(pass, &child, level + 1, problems, budget)).await;
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

async fn children_uncached(
    dir: &Path,
    level: usize,
    problems: &mut Vec<String>,
    budget: &mut crate::blocking::WorkBudget,
) -> Vec<Found> {
    let mut cache = DiscoveryCache::default();
    let mut pass = Pass {
        cache: &mut cache,
        force: true,
        now: std::time::Instant::now(),
        listings: HashSet::new(),
        descriptors: HashSet::new(),
    };
    children_of(&mut pass, dir, level, problems, budget).await
}

/// Real, visible directories directly inside `dir`, by name. A missing
/// directory has none.
async fn subdirectories(dir: &Path, budget: &mut crate::blocking::WorkBudget) -> Vec<PathBuf> {
    let Ok(reader) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for entry in reader.flatten() {
        budget.checkpoint().await;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // file_type does not follow symbolic links.
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    dirs
}
