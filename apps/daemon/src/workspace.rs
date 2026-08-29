//! Registered project roots. Every file and git call is scoped to one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    DirectoryEntry, DirectoryListing, FileNode, WorkspaceCapabilities, WorkspaceFolderInfo,
    WorkspaceInfo, WorkspaceKind,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::config::{AgentSpaceBinding, Config, WorkspaceEntry, WorkspaceFolderEntry};
use crate::session::WorkspaceHomes;

const MAX_DIRECTORY_ENTRIES: usize = 2000;
const MAX_WORKSPACE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WORKSPACE_FOLDERS: usize = 32;
const WORKSPACE_LAYOUT_FORMAT: u32 = 1;
const WORKSPACE_LAYOUT_FILE: &str = "workspace.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLayout {
    format: u32,
    #[serde(default)]
    children: Vec<WorkspaceLayoutChild>,
}

impl Default for WorkspaceLayout {
    fn default() -> Self {
        Self {
            format: WORKSPACE_LAYOUT_FORMAT,
            children: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceLayoutChild {
    source: String,
}

/// The only workspace metadata that may leave this machine for the Hub.
/// Absolute roots and repository details intentionally have no field here.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogWorkspace {
    pub local_workspace_id: String,
    pub reported_name: String,
    pub is_git_repo: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCatalog {
    pub generation: String,
    pub revision: u64,
    pub workspaces: Vec<CatalogWorkspace>,
}

pub struct Workspaces {
    entries: RwLock<HashMap<String, WorkspaceEntry>>,
    config_path: PathBuf,
    config: Arc<RwLock<Config>>,
    /// Sessions live inside their workspace, so the session store cannot find
    /// anything until it is told where each workspace is. Registration happens
    /// wherever an entry does, so the two can never disagree.
    homes: WorkspaceHomes,
}

/// Empty path asks for machine roots. Elsewhere `None` still means home.
pub fn list_directory(requested: Option<&Path>) -> Result<DirectoryListing> {
    if requested.is_some_and(|path| path.as_os_str().is_empty()) {
        return list_machine_roots();
    }

    let path = requested
        .map(crate::guest_paths::guest_path)
        .or_else(crate::config::home_dir)
        .ok_or_else(|| anyhow!("no home directory"))?
        .canonicalize()
        .context("no such directory")?;
    if !path.is_dir() {
        return Err(anyhow!("{} is not a directory", path.display()));
    }

    let mut directories = Vec::new();
    let mut workspace_files = Vec::new();
    for entry in std::fs::read_dir(&path)
        .with_context(|| format!("could not read {}", path.display()))?
        .take(MAX_DIRECTORY_ENTRIES)
        .flatten()
    {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let item = DirectoryEntry {
            name: entry.file_name().to_string_lossy().to_string(),
            path: entry.path().display().to_string(),
        };
        if kind.is_dir() {
            directories.push(item);
        } else if kind.is_file() && is_workspace_file(&entry.path()) {
            workspace_files.push(item);
        }
    }
    directories.sort_by_key(|entry| entry.name.to_lowercase());
    workspace_files.sort_by_key(|entry| entry.name.to_lowercase());

    Ok(DirectoryListing {
        path: path.display().to_string(),
        parent: listing_parent(&path),
        directories,
        workspace_files,
        roots: false,
    })
}

/// Creates `parent/name` on the daemon machine and returns the refreshed parent listing.
pub fn mkdir_directory(parent: &Path, name: &str) -> Result<DirectoryListing> {
    let name = validate_new_entry_name(name)?;
    if parent.as_os_str().is_empty() {
        return Err(anyhow!("cannot create a folder at the machine roots"));
    }
    let parent = crate::guest_paths::guest_path(parent)
        .canonicalize()
        .with_context(|| format!("no such directory: {}", parent.display()))?;
    if !parent.is_dir() {
        return Err(anyhow!("{} is not a directory", parent.display()));
    }
    let path = parent.join(name);
    if path.exists() {
        return Err(anyhow!("{} already exists", path.display()));
    }
    std::fs::create_dir(&path).with_context(|| format!("could not create {}", path.display()))?;
    list_directory(Some(&parent))
}

fn listing_parent(path: &Path) -> Option<String> {
    match path.parent() {
        // Volume roots have no real parent. The component sees a Windows
        // host's volumes as `/c`, `/d`, … — their parent is `/`, which is
        // not preopened there — so on a Windows host the picker climbs from
        // a volume root straight to the drive list (the empty path).
        Some(parent) if parent == Path::new("/") && crate::guest_paths::windows_host() => {
            Some(String::new())
        }
        Some(parent) if !parent.as_os_str().is_empty() => Some(parent.display().to_string()),
        // Natively a volume root (`C:\`) has no parent at all; `/` is the top
        // everywhere else.
        _ => {
            if crate::guest_paths::windows_host() {
                Some(String::new())
            } else {
                None
            }
        }
    }
}

fn list_machine_roots() -> Result<DirectoryListing> {
    let mut directories = machine_root_entries();
    directories.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(DirectoryListing {
        path: String::new(),
        parent: None,
        directories,
        workspace_files: Vec::new(),
        roots: true,
    })
}

fn machine_root_entries() -> Vec<DirectoryEntry> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let drive = format!("{}:\\", letter as char);
                let path = Path::new(&drive);
                if path.is_dir() {
                    Some(DirectoryEntry {
                        name: format!("{}:", letter as char),
                        path: drive,
                    })
                } else {
                    None
                }
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        // The component build reaches a Windows host's volumes through their
        // `/c`, `/d`, … preopens; there is no `/` to list there. Everywhere
        // else the filesystem root is the one root.
        let volumes = crate::guest_paths::windows_volumes();
        if !volumes.is_empty() {
            return volumes
                .iter()
                .map(|volume| DirectoryEntry {
                    name: format!("{}:", volume.letter),
                    path: volume.guest.clone(),
                })
                .collect();
        }
        vec![DirectoryEntry {
            name: "/".into(),
            path: "/".into(),
        }]
    }
}

fn validate_new_entry_name(name: &str) -> Result<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(anyhow!("folder name is required"));
    }
    if name.len() > 255 {
        return Err(anyhow!("folder name is too long"));
    }
    if name == "." || name == ".." {
        return Err(anyhow!("invalid folder name"));
    }
    if name.contains('/') || name.contains('\\') || name.contains('\0') {
        return Err(anyhow!("folder name cannot contain path separators"));
    }
    // The component build is never cfg(windows), but the machine behind it
    // can still be one — this is a host fact, so ask at runtime.
    if crate::guest_paths::windows_host() {
        const RESERVED: &[&str] = &[
            "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
            "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
        ];
        let stem = name.split('.').next().unwrap_or(name);
        if RESERVED.iter().any(|item| stem.eq_ignore_ascii_case(item)) {
            return Err(anyhow!("folder name is reserved on Windows"));
        }
        if name.chars().any(|ch| "<>:\"|?*".contains(ch)) {
            return Err(anyhow!("folder name contains an invalid character"));
        }
    }
    Ok(name)
}

#[derive(Debug, Clone)]
pub struct ResolvedWorkspacePath {
    pub root: PathBuf,
    pub absolute: PathBuf,
    pub relative: PathBuf,
    pub root_handle: String,
}

#[derive(Deserialize)]
struct CodeWorkspace {
    folders: Vec<CodeWorkspaceFolder>,
}

#[derive(Deserialize)]
struct CodeWorkspaceFolder {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    uri: Option<String>,
}

impl Workspaces {
    pub fn new(config: Arc<RwLock<Config>>, config_path: PathBuf, homes: WorkspaceHomes) -> Self {
        Workspaces {
            entries: RwLock::new(HashMap::new()),
            config_path,
            config,
            homes,
        }
    }

    pub async fn load(&self) {
        let mut entries = self.entries.write().await;
        let config = self.config.read().await;
        for entry in &config.workspaces {
            debug_assert!(!entry.folders.is_empty());
            debug_assert!(entry.folders.iter().all(|folder| {
                config.workspace_roots.iter().any(|mapping| {
                    mapping.handle == folder.root_handle && mapping.root == folder.root
                })
            }));
            if !entry.removed {
                self.homes
                    .attach_project(&entry.id, &session_project_key(entry), &entry.root);
            }
            entries.insert(entry.id.clone(), entry.clone());
        }
    }

    /// Gives a machine that has never been used somewhere to work.
    ///
    /// Without this the first thing a new install can do is refuse: no
    /// workspace means no session, which means the first screen is a file
    /// picker in front of a product the user has not seen yet. The folder is
    /// created if it is missing, and it is an ordinary directory — deleting it
    /// or ignoring it costs nothing.
    ///
    /// Only ever runs on an empty registry, so a user who opened their own
    /// projects never sees it appear.
    pub async fn ensure_default(&self, root: &Path) -> Result<WorkspaceInfo> {
        if let Some(existing) = self.entries.read().await.values().next() {
            // A user who deliberately removed their last project should come
            // back to an empty registry, not find a new default folder created
            // behind their back. The retained entry is enough to distinguish
            // that from a machine which has never opened anything.
            return Ok(describe(existing));
        }
        std::fs::create_dir_all(root)
            .with_context(|| format!("creating the default workspace at {}", root.display()))?;
        self.open(root, None).await
    }

    pub async fn list(&self) -> Vec<WorkspaceInfo> {
        let entries = self.entries.read().await;
        let config = self.config.read().await;
        let ordered = config
            .workspaces
            .iter()
            .filter_map(|saved| entries.get(&saved.id))
            .filter(|entry| !entry.removed)
            .collect::<Vec<_>>();
        let layout = workspace_layout_projection(&ordered);
        ordered
            .into_iter()
            .enumerate()
            .map(|(index, entry)| {
                let (parent, order, managed) =
                    layout
                        .get(&entry.id)
                        .cloned()
                        .unwrap_or((None, index as u32, false));
                describe_with_layout(entry, parent, order, managed)
            })
            .collect()
    }

    /// Moves an ordinary workspace in the explicit presentation hierarchy.
    /// PM-owned Agent Spaces are projected from their durable binding and are
    /// intentionally not writable through this surface.
    pub async fn move_layout(
        &self,
        workspace_id: &str,
        parent_workspace_id: Option<&str>,
        before_workspace_id: Option<&str>,
    ) -> Result<Vec<WorkspaceInfo>> {
        let entries = self.entries.read().await;
        let mut config = self.config.write().await;
        let ordered = config
            .workspaces
            .iter()
            .filter_map(|saved| entries.get(&saved.id))
            .filter(|entry| !entry.removed)
            .cloned()
            .collect::<Vec<_>>();
        let by_id = ordered
            .iter()
            .map(|entry| (entry.id.as_str(), entry))
            .collect::<HashMap<_, _>>();
        let child = by_id
            .get(workspace_id)
            .copied()
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        if child.kind == WorkspaceKind::AgentSpace {
            anyhow::bail!("an Agent Space stays under its project manager");
        }
        let parent = parent_workspace_id
            .map(|id| {
                by_id
                    .get(id)
                    .copied()
                    .ok_or_else(|| anyhow!("no such parent workspace: {id}"))
            })
            .transpose()?;
        if parent.is_some_and(|parent| parent.id == child.id) {
            anyhow::bail!("a workspace cannot contain itself");
        }
        if parent.is_some_and(|parent| parent.kind == WorkspaceKind::AgentSpace) {
            anyhow::bail!("an Agent Space cannot own user-arranged workspaces");
        }

        let projection = workspace_layout_projection(&ordered.iter().collect::<Vec<_>>());
        let destination_parent = parent.map(|entry| entry.id.as_str());
        if let Some(before_id) = before_workspace_id {
            if before_id == workspace_id {
                anyhow::bail!("a workspace cannot be ordered before itself");
            }
            let before = by_id
                .get(before_id)
                .copied()
                .ok_or_else(|| anyhow!("no such destination sibling: {before_id}"))?;
            if before.kind == WorkspaceKind::AgentSpace {
                anyhow::bail!("a PM-managed Agent Space cannot be used as an ordering anchor");
            }
            let before_parent = projection
                .get(&before.id)
                .and_then(|(parent, _, _)| parent.as_deref());
            if before_parent != destination_parent {
                anyhow::bail!("the ordering target is not in the destination");
            }
        }
        let mut ancestor = destination_parent;
        while let Some(id) = ancestor {
            if id == workspace_id {
                anyhow::bail!("workspace layout cannot contain a cycle");
            }
            ancestor = projection
                .get(id)
                .and_then(|(parent, _, _)| parent.as_deref());
        }

        let mut layouts = HashMap::<String, (WorkspaceEntry, WorkspaceLayout)>::new();
        if let Some(current_parent_id) = projection
            .get(workspace_id)
            .and_then(|(current, _, _)| current.as_deref())
        {
            let current_parent = by_id
                .get(current_parent_id)
                .copied()
                .ok_or_else(|| anyhow!("current parent workspace is unavailable"))?;
            let mut layout = read_workspace_layout(current_parent)?;
            layout
                .children
                .retain(|item| !layout_child_matches(current_parent, item, child));
            layouts.insert(current_parent.id.clone(), (current_parent.clone(), layout));
        }

        if let Some(parent) = parent {
            if !layouts.contains_key(&parent.id) {
                layouts.insert(
                    parent.id.clone(),
                    (parent.clone(), read_workspace_layout(parent)?),
                );
            }
            let (_, layout) = layouts.get_mut(&parent.id).expect("layout inserted above");
            let source = relative_workspace_source(parent, child)?;
            let position = before_workspace_id
                .and_then(|before_id| {
                    let before = by_id.get(before_id).copied()?;
                    layout
                        .children
                        .iter()
                        .position(|item| layout_child_matches(parent, item, before))
                })
                .unwrap_or(layout.children.len());
            layout
                .children
                .insert(position, WorkspaceLayoutChild { source });
        }

        for (_, (parent, layout)) in layouts {
            write_workspace_layout(&parent, &layout)?;
        }

        if parent_workspace_id.is_none() {
            let mut next = config.clone();
            let position = next
                .workspaces
                .iter()
                .position(|entry| entry.id == workspace_id)
                .ok_or_else(|| anyhow!("workspace {workspace_id} is missing from config"))?;
            let moved = next.workspaces.remove(position);
            let destination = before_workspace_id
                .and_then(|id| next.workspaces.iter().position(|entry| entry.id == id))
                .unwrap_or(next.workspaces.len());
            next.workspaces.insert(destination, moved);
            next.save(&self.config_path)?;
            *config = next;
        }
        drop(config);
        drop(entries);
        Ok(self.list().await)
    }

    /// A stable, path-free snapshot suitable for account-wide discovery.
    pub async fn catalog(&self) -> WorkspaceCatalog {
        let entries = self.entries.read().await;
        let mut workspaces: Vec<CatalogWorkspace> = entries
            .values()
            .filter(|entry| !entry.removed)
            .map(|entry| CatalogWorkspace {
                local_workspace_id: entry.id.clone(),
                reported_name: safe_catalog_name(&entry.name, &entry.id),
                is_git_repo: entry.is_git_repo,
            })
            .collect();
        workspaces.sort_by(|a, b| a.local_workspace_id.cmp(&b.local_workspace_id));
        // Mutations take the entries lock before the config lock. Keep the same
        // order here so a rename and a background upload cannot deadlock.
        let config = self.config.read().await;
        WorkspaceCatalog {
            generation: config.workspace_catalog_generation.clone(),
            revision: config.workspace_catalog_revision,
            workspaces,
        }
    }

    pub async fn get(&self, id: &str) -> Result<WorkspaceEntry> {
        let entry = self
            .entries
            .read()
            .await
            .get(id)
            .filter(|entry| !entry.removed)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        hydrate_entry(entry, &self.config.read().await.workspace_roots)
    }

    /// Resolves `<rootHandle>/<recursive relative path>` inside one project.
    /// The handle is device-wide; project membership is checked before the
    /// capability-confined filesystem path is opened.
    pub async fn resolve(
        &self,
        workspace_id: &str,
        relative: &str,
    ) -> Result<ResolvedWorkspacePath> {
        let entry = self.get(workspace_id).await?;
        resolve_entry(&entry, relative)
    }

    pub async fn tree(
        &self,
        workspace_id: &str,
        path: Option<&str>,
        depth: u32,
    ) -> Result<FileNode> {
        let entry = self.get(workspace_id).await?;
        if entry.workspace_file.is_some() && path.is_none() {
            let children = if depth == 0 {
                None
            } else {
                Some(
                    entry
                        .folders
                        .iter()
                        .map(|folder| {
                            crate::files::tree_with_prefix(
                                &folder.root,
                                &folder.root,
                                depth.saturating_sub(1),
                                &folder.root_handle,
                                Some(&folder.name),
                            )
                        })
                        .collect::<Result<Vec<_>>>()?,
                )
            };
            return Ok(FileNode {
                name: entry.name,
                path: String::new(),
                is_dir: true,
                size: None,
                children,
            });
        }

        if path.is_none() {
            let folder = entry
                .folders
                .first()
                .ok_or_else(|| anyhow!("workspace has no folders"))?;
            return crate::files::tree_with_prefix(
                &folder.root,
                &folder.root,
                depth,
                &folder.root_handle,
                Some(&folder.name),
            );
        }

        let requested = path.expect("handled the project root above");
        let resolved = resolve_entry(&entry, requested)?;
        crate::files::tree_with_prefix(
            &resolved.root,
            &resolved.absolute,
            depth,
            &resolved.root_handle,
            if resolved.relative.as_os_str().is_empty() {
                entry
                    .folders
                    .iter()
                    .find(|folder| folder.root_handle == resolved.root_handle)
                    .map(|folder| folder.name.as_str())
            } else {
                None
            },
        )
    }

    /// Registers a root, or returns the existing entry if it is already known.
    ///
    /// Opening the same folder twice is a normal thing for a user to do and
    /// should not produce two entries pointing at one directory.
    pub async fn open(&self, root: &Path, name: Option<String>) -> Result<WorkspaceInfo> {
        // A Windows host's spelling (`F:\dir`, or the `\\?\` verbatim form a
        // native caller canonicalized) names the same directory the guest can
        // only reach through its volume preopens — translate before anything
        // touches the filesystem.
        let root = crate::guest_paths::guest_path(root);
        let source = root
            .canonicalize()
            .with_context(|| format!("no such folder or workspace file: {}", root.display()))?;
        let candidate = if source.is_dir() {
            folder_workspace(source, name)
        } else if source.is_file() && is_workspace_file(&source) && name.is_none() {
            code_workspace(&source)?
        } else {
            return Err(anyhow!(
                "{} is neither a directory nor a .code-workspace file",
                source.display()
            ));
        };

        self.register_candidate(candidate, None).await
    }

    /// Registers a Builder-produced Space source as an explicit Agent Space.
    ///
    /// The source remains ordinary Git-managed project data. This registry only
    /// persists its product kind and the PM controller relationship.
    pub async fn register_agent_space(
        &self,
        source: &Path,
        project: &WorkspaceEntry,
        controller_session_id: &str,
    ) -> Result<WorkspaceInfo> {
        if project.kind != WorkspaceKind::Folder || project.agent_space.is_some() {
            anyhow::bail!("a PM project must start from a Folder workspace");
        }
        let source = source
            .canonicalize()
            .with_context(|| format!("no such Agent Space workspace file: {}", source.display()))?;
        if !source.is_file() || !is_workspace_file(&source) {
            anyhow::bail!("an Agent Space source must be a .code-workspace file");
        }
        let space_root = source
            .parent()
            .ok_or_else(|| anyhow!("Agent Space workspace file has no parent"))?;
        let spaces_root = project
            .root
            .join("spaces")
            .canonicalize()
            .context("the PM project has no spaces directory")?;
        if space_root.parent() != Some(spaces_root.as_path()) {
            anyhow::bail!(
                "Agent Space source must be directly under {}/<space>/",
                spaces_root.display()
            );
        }
        if !space_root.join("pipespace.json").is_file() {
            anyhow::bail!("Agent Space source has no pipespace.json");
        }
        let verified = crate::agent_space_builder::verify_space(&project.root, space_root)
            .context("Agent Space Builder verification failed")?;
        if verified.workspace_path != source {
            anyhow::bail!(
                "Agent Space registration must use the Builder-bound workspace file {}",
                verified.workspace_path.display()
            );
        }

        let candidate = code_workspace(&source)?;
        if candidate
            .folders
            .first()
            .map(|folder| folder.root.as_path())
            != Some(space_root)
        {
            anyhow::bail!("an Agent Space workspace must list its own root as the first folder");
        }
        self.register_candidate(
            candidate,
            Some(AgentSpaceBinding {
                project_workspace_id: project.id.clone(),
                controller_session_id: controller_session_id.to_string(),
            }),
        )
        .await
    }

    async fn register_candidate(
        &self,
        mut candidate: WorkspaceEntry,
        agent_space: Option<AgentSpaceBinding>,
    ) -> Result<WorkspaceInfo> {
        if let Some(binding) = agent_space.clone() {
            candidate.kind = WorkspaceKind::AgentSpace;
            candidate.agent_space = Some(binding);
        }

        // Keep the write lock from the source identity check through commit.
        // A folder source and a `.code-workspace` source remain distinct even
        // when their Agent roots happen to be the same directory.
        let mut entries = self.entries.write().await;
        let mut config = self.config.write().await;
        let mut next = config.clone();
        let mut candidate = candidate;
        for folder in &mut candidate.folders {
            folder.root_handle = next.ensure_workspace_root(&folder.root);
        }
        if let Some(existing) = entries
            .values()
            .find(|entry| same_project_source(entry, &candidate))
            .cloned()
        {
            if agent_space.is_none() && existing.kind == WorkspaceKind::AgentSpace {
                if existing.removed {
                    anyhow::bail!("an Agent Space can only be reactivated by its project manager");
                }
                return Ok(describe(&existing));
            }
            if let Some(binding) = agent_space.as_ref() {
                if existing.kind == WorkspaceKind::AgentSpace
                    && existing.agent_space.as_ref() != Some(binding)
                {
                    anyhow::bail!("this Agent Space belongs to another project manager");
                }
            }
            let mut updated = candidate;
            updated.id = existing.id.clone();
            // The label belongs to the durable project identity, not whichever
            // folder/workspace-file view most recently opened it. In particular,
            // switching views must not erase a name the user chose.
            updated.name = existing.name.clone();
            updated.removed = false;
            if updated == existing {
                return Ok(describe(&existing));
            }

            let catalog_changed = existing.removed
                || existing.name != updated.name
                || existing.is_git_repo != updated.is_git_repo;
            let saved = next
                .workspaces
                .iter_mut()
                .find(|entry| entry.id == existing.id)
                .ok_or_else(|| anyhow!("workspace {} is missing from config", existing.id))?;
            *saved = updated.clone();
            if catalog_changed {
                next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
            }
            next.save(&self.config_path)?;
            *config = next;
            self.homes
                .attach_project(&updated.id, &session_project_key(&updated), &updated.root);
            entries.insert(updated.id.clone(), updated.clone());
            return Ok(describe(&updated));
        }

        let entry = candidate;
        next.workspaces.push(entry.clone());
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        // Publish to memory only after the durable snapshot exists. Otherwise
        // the background Hub sync could upload a revision that restart loses.
        next.save(&self.config_path)?;
        *config = next;
        self.homes
            .attach_project(&entry.id, &session_project_key(&entry), &entry.root);
        entries.insert(entry.id.clone(), entry.clone());

        Ok(describe(&entry))
    }

    /// Removes a project from the active registry without touching its files or
    /// conversations. The durable entry is a tombstone with enough identity to
    /// reactivate the same id when the source is opened again.
    pub async fn remove(&self, id: &str) -> Result<Vec<WorkspaceInfo>> {
        self.remove_with_controller(id, None).await
    }

    /// The PM-only counterpart to [`Self::remove`]. The router authenticates
    /// the caller; this layer rechecks the durable Agent Space binding so a
    /// routing mistake still cannot remove another manager's topology.
    pub async fn remove_agent_space(
        &self,
        id: &str,
        controller_session_id: &str,
    ) -> Result<Vec<WorkspaceInfo>> {
        self.remove_with_controller(id, Some(controller_session_id))
            .await
    }

    async fn remove_with_controller(
        &self,
        id: &str,
        controller_session_id: Option<&str>,
    ) -> Result<Vec<WorkspaceInfo>> {
        let mut entries = self.entries.write().await;
        let entry = entries
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        if entry.removed {
            drop(entries);
            return Ok(self.list().await);
        }
        if entry.kind == WorkspaceKind::AgentSpace {
            let expected = entry
                .agent_space
                .as_ref()
                .map(|binding| binding.controller_session_id.as_str());
            if expected != controller_session_id {
                anyhow::bail!("removing an Agent Space requires its project manager");
            }
        } else if controller_session_id.is_some() {
            anyhow::bail!("the PM removal path only accepts Agent Spaces");
        }

        let mut updated = entry;
        updated.removed = true;
        let mut config = self.config.write().await;
        let mut next = config.clone();
        let saved = next
            .workspaces
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| anyhow!("workspace {id} is missing from config"))?;
        saved.removed = true;
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        next.save(&self.config_path)?;
        *config = next;
        entries.insert(id.to_string(), updated);
        self.homes.detach(id);

        drop(config);
        drop(entries);
        Ok(self.list().await)
    }

    /// Changes only the label shown to the user; the directory itself stays put.
    pub async fn rename(&self, id: &str, name: &str) -> Result<WorkspaceInfo> {
        let name: String = name.trim().chars().take(80).collect();
        if name.is_empty() {
            return Err(anyhow!("workspace name cannot be empty"));
        }

        let mut entries = self.entries.write().await;
        let entry = entries
            .get(id)
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        if entry.removed {
            return Err(anyhow!("no such workspace: {id}"));
        }
        if entry.name == name {
            return Ok(describe(entry));
        }
        let mut updated = entry.clone();
        updated.name = name;

        let mut config = self.config.write().await;
        let mut next = config.clone();
        let saved = next
            .workspaces
            .iter_mut()
            .find(|entry| entry.id == id)
            .ok_or_else(|| anyhow!("workspace {id} is missing from config"))?;
        saved.name = updated.name.clone();
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        next.save(&self.config_path)?;
        *config = next;
        entries.insert(id.to_string(), updated.clone());

        Ok(describe(&updated))
    }
}

fn describe(entry: &WorkspaceEntry) -> WorkspaceInfo {
    let capabilities = match entry.kind {
        WorkspaceKind::AgentSpace => WorkspaceCapabilities {
            create_session: true,
            rename: false,
            remove: false,
        },
        WorkspaceKind::Folder | WorkspaceKind::PipeSpace => WorkspaceCapabilities {
            create_session: true,
            rename: true,
            remove: true,
        },
    };
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        kind: Some(entry.kind),
        capabilities: Some(capabilities),
        root: entry.root.display().to_string(),
        is_git_repo: entry.is_git_repo,
        folders: entry
            .folders
            .iter()
            .map(|folder| WorkspaceFolderInfo {
                name: folder.name.clone(),
                root: folder.root.display().to_string(),
                root_handle: folder.root_handle.clone(),
            })
            .collect(),
        parent_workspace_id: entry
            .agent_space
            .as_ref()
            .map(|binding| binding.project_workspace_id.clone()),
        layout_order: Some(0),
        layout_managed: Some(entry.kind == WorkspaceKind::AgentSpace),
        workspace_file: entry
            .workspace_file
            .as_ref()
            .map(|path| path.display().to_string()),
    }
}

fn describe_with_layout(
    entry: &WorkspaceEntry,
    parent_workspace_id: Option<String>,
    layout_order: u32,
    layout_managed: bool,
) -> WorkspaceInfo {
    let mut workspace = describe(entry);
    workspace.parent_workspace_id = parent_workspace_id;
    workspace.layout_order = Some(layout_order);
    workspace.layout_managed = Some(layout_managed);
    workspace
}

fn workspace_definition_dir(entry: &WorkspaceEntry) -> &Path {
    entry
        .workspace_file
        .as_ref()
        .and_then(|path| path.parent())
        .unwrap_or(&entry.root)
}

fn workspace_source(entry: &WorkspaceEntry) -> &Path {
    entry.workspace_file.as_deref().unwrap_or(&entry.root)
}

fn workspace_layout_path(entry: &WorkspaceEntry) -> PathBuf {
    workspace_definition_dir(entry)
        .join(".genethub")
        .join(WORKSPACE_LAYOUT_FILE)
}

fn read_workspace_layout(entry: &WorkspaceEntry) -> Result<WorkspaceLayout> {
    let path = workspace_layout_path(entry);
    if !path.exists() {
        return Ok(WorkspaceLayout::default());
    }
    let metadata = std::fs::metadata(&path)
        .with_context(|| format!("reading workspace layout metadata at {}", path.display()))?;
    if metadata.len() > MAX_WORKSPACE_FILE_BYTES {
        anyhow::bail!("workspace layout is too large: {}", path.display());
    }
    let source = std::fs::read_to_string(&path)
        .with_context(|| format!("reading workspace layout at {}", path.display()))?;
    let layout: WorkspaceLayout = serde_json::from_str(&source)
        .with_context(|| format!("parsing workspace layout at {}", path.display()))?;
    if layout.format != WORKSPACE_LAYOUT_FORMAT {
        anyhow::bail!(
            "unsupported workspace layout format {} at {}",
            layout.format,
            path.display()
        );
    }
    if layout.children.len() > MAX_DIRECTORY_ENTRIES
        || layout
            .children
            .iter()
            .any(|child| child.source.trim().is_empty())
    {
        anyhow::bail!("invalid workspace layout at {}", path.display());
    }
    Ok(layout)
}

fn read_workspace_layout_projection(entry: &WorkspaceEntry) -> WorkspaceLayout {
    read_workspace_layout(entry).unwrap_or_else(|error| {
        tracing::warn!(
            workspace_id = %entry.id,
            error = %format!("{error:#}"),
            "ignoring invalid workspace presentation layout"
        );
        WorkspaceLayout::default()
    })
}

fn resolved_layout_source(parent: &WorkspaceEntry, item: &WorkspaceLayoutChild) -> PathBuf {
    let source = Path::new(&item.source);
    let joined = if source.is_absolute() {
        source.to_path_buf()
    } else {
        workspace_definition_dir(parent).join(source)
    };
    joined.canonicalize().unwrap_or(joined)
}

fn normalized_workspace_source(entry: &WorkspaceEntry) -> PathBuf {
    workspace_source(entry)
        .canonicalize()
        .unwrap_or_else(|_| workspace_source(entry).to_path_buf())
}

fn layout_child_matches(
    parent: &WorkspaceEntry,
    item: &WorkspaceLayoutChild,
    child: &WorkspaceEntry,
) -> bool {
    resolved_layout_source(parent, item) == normalized_workspace_source(child)
}

fn relative_workspace_source(parent: &WorkspaceEntry, child: &WorkspaceEntry) -> Result<String> {
    let source = workspace_source(child);
    let relative = pathdiff::diff_paths(source, workspace_definition_dir(parent))
        .unwrap_or_else(|| source.to_path_buf());
    let value = relative.to_string_lossy().to_string();
    if value.trim().is_empty() {
        anyhow::bail!("workspace source cannot be empty");
    }
    Ok(value)
}

fn write_workspace_layout(entry: &WorkspaceEntry, layout: &WorkspaceLayout) -> Result<()> {
    let path = workspace_layout_path(entry);
    let mut source = serde_json::to_string_pretty(layout)?;
    source.push('\n');
    crate::config::save_private(&path, source.as_bytes())
        .with_context(|| format!("saving workspace layout at {}", path.display()))
}

fn workspace_layout_projection(
    entries: &[&WorkspaceEntry],
) -> HashMap<String, (Option<String>, u32, bool)> {
    let mut projection = entries
        .iter()
        .enumerate()
        .map(|(index, entry)| (entry.id.clone(), (None, index as u32, false)))
        .collect::<HashMap<_, _>>();

    for parent in entries {
        if parent.kind == WorkspaceKind::AgentSpace {
            continue;
        }
        let layout = read_workspace_layout_projection(parent);
        for (order, item) in layout.children.iter().enumerate() {
            let Some(child) = entries.iter().copied().find(|candidate| {
                candidate.kind != WorkspaceKind::AgentSpace
                    && layout_child_matches(parent, item, candidate)
            }) else {
                continue;
            };
            if projection
                .get(&child.id)
                .and_then(|(existing, _, _)| existing.as_ref())
                .is_some()
            {
                continue;
            }
            let mut ancestor = Some(parent.id.as_str());
            let mut cycle = false;
            while let Some(id) = ancestor {
                if id == child.id {
                    cycle = true;
                    break;
                }
                ancestor = projection
                    .get(id)
                    .and_then(|(owner, _, _)| owner.as_deref());
            }
            if cycle {
                tracing::warn!(
                    parent_workspace_id = %parent.id,
                    child_workspace_id = %child.id,
                    "ignoring cyclic workspace presentation relationship"
                );
                continue;
            }
            projection.insert(
                child.id.clone(),
                (Some(parent.id.clone()), order as u32, false),
            );
        }
    }

    for (order, entry) in entries.iter().enumerate() {
        if entry.kind != WorkspaceKind::AgentSpace {
            continue;
        }
        let parent = entry
            .agent_space
            .as_ref()
            .map(|binding| binding.project_workspace_id.clone())
            .filter(|id| projection.contains_key(id));
        projection.insert(entry.id.clone(), (parent, order as u32, true));
    }

    projection
}

fn folder_workspace(root: PathBuf, name: Option<String>) -> WorkspaceEntry {
    let folder_name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());
    WorkspaceEntry {
        id: format!("w_{}", uuid::Uuid::new_v4().simple()),
        name: name.unwrap_or_else(|| folder_name.clone()),
        kind: if root.join("pipespace.json").is_file() {
            WorkspaceKind::PipeSpace
        } else {
            WorkspaceKind::Folder
        },
        agent_space: None,
        root: root.clone(),
        folders: vec![WorkspaceFolderEntry {
            name: folder_name,
            root: root.clone(),
            root_handle: String::new(),
        }],
        workspace_file: None,
        removed: false,
        is_git_repo: root.join(".git").exists(),
    }
}

fn code_workspace(path: &Path) -> Result<WorkspaceEntry> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("reading workspace file {}", path.display()))?;
    if metadata.len() > MAX_WORKSPACE_FILE_BYTES {
        anyhow::bail!(
            "workspace file is {} bytes, above the {} byte limit",
            metadata.len(),
            MAX_WORKSPACE_FILE_BYTES
        );
    }
    let source = std::fs::read_to_string(path)
        .with_context(|| format!("reading workspace file {} as UTF-8", path.display()))?;
    let parsed: CodeWorkspace = json5::from_str(&source)
        .with_context(|| format!("parsing workspace file {}", path.display()))?;
    if parsed.folders.is_empty() {
        anyhow::bail!("workspace file must contain at least one folder");
    }
    if parsed.folders.len() > MAX_WORKSPACE_FOLDERS {
        anyhow::bail!(
            "workspace file contains {} folders, above the {} folder limit",
            parsed.folders.len(),
            MAX_WORKSPACE_FOLDERS
        );
    }

    let base = path
        .parent()
        .ok_or_else(|| anyhow!("workspace file has no parent directory"))?;
    let mut roots = HashSet::new();
    let mut folders = Vec::with_capacity(parsed.folders.len());
    for (index, folder) in parsed.folders.into_iter().enumerate() {
        if folder.uri.is_some() {
            anyhow::bail!(
                "workspace folder {} uses a URI; this version supports local path entries only",
                index + 1
            );
        }
        let raw = folder
            .path
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("workspace folder {} has no path", index + 1))?;
        if raw.contains('\0') {
            anyhow::bail!("workspace folder {} contains NUL", index + 1);
        }
        // A .code-workspace written on Windows names its folders in the
        // host's spelling, which is not absolute from the guest's POSIX point
        // of view — translate first, then classify.
        let requested = crate::guest_paths::guest_path(Path::new(&raw));
        let requested = if requested.is_absolute() {
            requested
        } else {
            base.join(requested)
        };
        let root = requested.canonicalize().with_context(|| {
            format!(
                "workspace folder {} does not exist: {}",
                index + 1,
                requested.display()
            )
        })?;
        if !root.is_dir() {
            anyhow::bail!(
                "workspace folder {} is not a directory: {}",
                index + 1,
                root.display()
            );
        }
        if !roots.insert(root.clone()) {
            anyhow::bail!("workspace file contains the same folder more than once");
        }
        let name = workspace_folder_name(folder.name.as_deref(), &root)?;
        folders.push(WorkspaceFolderEntry {
            name,
            root,
            root_handle: String::new(),
        });
    }

    let root = folders[0].root.clone();
    let name = path
        .file_stem()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| folders[0].name.clone());
    Ok(WorkspaceEntry {
        id: format!("w_{}", uuid::Uuid::new_v4().simple()),
        name,
        kind: if base.join("pipespace.json").is_file() {
            WorkspaceKind::PipeSpace
        } else {
            WorkspaceKind::Folder
        },
        agent_space: None,
        root: root.clone(),
        folders,
        workspace_file: Some(path.to_path_buf()),
        removed: false,
        is_git_repo: root.join(".git").exists(),
    })
}

fn workspace_folder_name(configured: Option<&str>, root: &Path) -> Result<String> {
    let fallback = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());
    let value = configured.unwrap_or(&fallback).trim();
    if value.is_empty()
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
        })
    {
        anyhow::bail!("workspace folder name is empty or contains control characters");
    }
    Ok(value.chars().take(80).collect())
}

fn is_workspace_file(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("code-workspace"))
}

fn resolve_entry(entry: &WorkspaceEntry, virtual_path: &str) -> Result<ResolvedWorkspacePath> {
    if virtual_path.contains('\0') || virtual_path.contains('\\') {
        anyhow::bail!("workspace path is not canonical");
    }
    if matches!(virtual_path, "" | ".") {
        anyhow::bail!("a workspace resource path must name its root handle");
    }
    let (handle, relative) = virtual_path
        .split_once('/')
        .map_or((virtual_path, ""), |(handle, tail)| (handle, tail));
    let folder = entry
        .folders
        .iter()
        .find(|folder| folder.root_handle == handle)
        .ok_or_else(|| anyhow!("root handle is not a member of this workspace"))?;
    let requested = if matches!(relative, "" | ".") {
        Path::new(".")
    } else {
        Path::new(relative)
    };
    let absolute = crate::session::ensure_within(&folder.root, requested)?;
    let relative = absolute
        .strip_prefix(&folder.root)
        .map_err(|_| anyhow!("path escapes the workspace folder"))?
        .to_path_buf();
    Ok(ResolvedWorkspacePath {
        root: folder.root.clone(),
        absolute,
        relative,
        root_handle: folder.root_handle.clone(),
    })
}

fn hydrate_entry(
    mut entry: WorkspaceEntry,
    mappings: &[crate::config::WorkspaceRootEntry],
) -> Result<WorkspaceEntry> {
    for folder in &mut entry.folders {
        let mapping = mappings
            .iter()
            .find(|mapping| mapping.handle == folder.root_handle)
            .ok_or_else(|| anyhow!("no such filesystem root: {}", folder.root_handle))?;
        folder.root = mapping.root.clone();
    }
    entry.root = entry
        .folders
        .first()
        .ok_or_else(|| anyhow!("workspace has no folders"))?
        .root
        .clone();
    Ok(entry)
}

fn same_project_source(left: &WorkspaceEntry, right: &WorkspaceEntry) -> bool {
    left.root == right.root
        && match (&left.workspace_file, &right.workspace_file) {
            (None, None) => true,
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
}

fn session_project_key(entry: &WorkspaceEntry) -> String {
    match &entry.workspace_file {
        None => "folder".to_string(),
        Some(path) => {
            let mut digest = Sha256::new();
            digest.update(b"genehub-workspace-source-v1\0");
            update_path_digest(&mut digest, path);
            format!("workspace:{:x}", digest.finalize())
        }
    }
}

#[cfg(unix)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    use std::os::unix::ffi::OsStrExt;
    digest.update(path.as_os_str().as_bytes());
}

#[cfg(windows)]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    for unit in path.as_os_str().encode_wide() {
        digest.update(unit.to_le_bytes());
    }
}

#[cfg(not(any(unix, windows)))]
fn update_path_digest(digest: &mut Sha256, path: &Path) {
    digest.update(path.to_string_lossy().as_bytes());
}

/// Produces a Hub-safe display label without letting one legacy/local name
/// poison the complete catalogue snapshot. The local name is left untouched;
/// only the path-free discovery projection gets a deterministic fallback.
fn safe_catalog_name(name: &str, local_workspace_id: &str) -> String {
    let trimmed = name.trim();
    let invalid = trimmed.is_empty()
        || trimmed.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
                )
        });
    if !invalid {
        return trimmed.chars().take(80).collect();
    }
    let suffix: String = local_workspace_id
        .chars()
        .rev()
        .take(8)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    format!("Workspace · {suffix}")
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn workspaces(dir: &Path) -> Workspaces {
        let config = Arc::new(RwLock::new(Config::default()));
        Workspaces::new(config, dir.join("config.json"), WorkspaceHomes::default())
    }

    #[tokio::test]
    async fn opening_a_directory_registers_it_once() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let spaces = workspaces(dir.path()).await;

        let first = spaces.open(&project, None).await.unwrap();
        let second = spaces.open(&project, None).await.unwrap();
        assert_eq!(first.id, second.id, "the same folder is one workspace");
        assert_eq!(first.name, "project");
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn explicit_layout_survives_copy_without_inferring_any_path_hierarchy() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let feature = project.join("feature");
        std::fs::create_dir_all(&feature).unwrap();
        let spaces = workspaces(dir.path()).await;
        let project_workspace = spaces.open(&project, None).await.unwrap();
        let feature_workspace = spaces.open(&feature, None).await.unwrap();

        let flat = spaces.list().await;
        assert_eq!(
            flat.iter()
                .find(|entry| entry.id == feature_workspace.id)
                .and_then(|entry| entry.parent_workspace_id.as_deref()),
            None,
            "a nested directory is not an implicit child"
        );

        let moved = spaces
            .move_layout(&feature_workspace.id, Some(&project_workspace.id), None)
            .await
            .unwrap();
        assert_eq!(
            moved
                .iter()
                .find(|entry| entry.id == feature_workspace.id)
                .and_then(|entry| entry.parent_workspace_id.as_deref()),
            Some(project_workspace.id.as_str())
        );
        let saved: WorkspaceLayout = serde_json::from_str(
            &std::fs::read_to_string(project.join(".genethub/workspace.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(saved.children[0].source, "feature");
        assert!(spaces
            .move_layout(&project_workspace.id, Some(&feature_workspace.id), None)
            .await
            .is_err());

        let copied = dir.path().join("copied");
        let copied_feature = copied.join("feature");
        std::fs::create_dir_all(copied.join(".genethub")).unwrap();
        std::fs::create_dir_all(&copied_feature).unwrap();
        std::fs::copy(
            project.join(".genethub/workspace.json"),
            copied.join(".genethub/workspace.json"),
        )
        .unwrap();
        let copied_project = spaces.open(&copied, None).await.unwrap();
        let copied_child = spaces.open(&copied_feature, None).await.unwrap();
        let copied_projection = spaces.list().await;
        assert_eq!(
            copied_projection
                .iter()
                .find(|entry| entry.id == copied_child.id)
                .and_then(|entry| entry.parent_workspace_id.as_deref()),
            Some(copied_project.id.as_str()),
            "relative sources preserve semantics when the workspace tree is copied"
        );

        let roots = spaces
            .move_layout(&feature_workspace.id, None, Some(&copied_project.id))
            .await
            .unwrap();
        assert!(roots
            .iter()
            .find(|entry| entry.id == feature_workspace.id)
            .unwrap()
            .parent_workspace_id
            .is_none());
    }

    #[tokio::test]
    async fn only_explicit_pm_registration_promotes_a_built_space_to_agent_space() {
        let dir = tempfile::tempdir().unwrap();
        let project_root = dir.path().join("project");
        let space_root = project_root.join("spaces/code");
        std::fs::create_dir_all(project_root.join("spaces")).unwrap();
        crate::agent_space_builder::run(
            &project_root,
            &space_root,
            crate::agent_space_builder::Command::Init,
            true,
        )
        .unwrap();
        crate::agent_space_builder::run(
            &project_root,
            &space_root,
            crate::agent_space_builder::Command::Build { dry_run: false },
            true,
        )
        .unwrap();
        let source = space_root.join("code.code-workspace");

        let spaces = workspaces(dir.path()).await;
        let project = spaces.open(&project_root, None).await.unwrap();
        assert_eq!(project.kind, Some(WorkspaceKind::Folder));

        let discovered = spaces.open(&source, None).await.unwrap();
        assert_eq!(discovered.kind, Some(WorkspaceKind::PipeSpace));

        let project_entry = spaces.get(&project.id).await.unwrap();
        let promoted = spaces
            .register_agent_space(&source, &project_entry, "s_pm")
            .await
            .unwrap();
        assert_eq!(promoted.id, discovered.id);
        assert_eq!(promoted.kind, Some(WorkspaceKind::AgentSpace));
        assert_eq!(
            promoted.parent_workspace_id.as_deref(),
            Some(project.id.as_str())
        );
        assert_eq!(promoted.layout_managed, Some(true));
        assert_eq!(
            promoted.capabilities.as_ref().map(|caps| caps.remove),
            Some(false)
        );
        let binding = spaces.get(&promoted.id).await.unwrap().agent_space.unwrap();
        assert_eq!(binding.project_workspace_id, project.id);
        assert_eq!(binding.controller_session_id, "s_pm");

        let reopened = spaces.open(&source, None).await.unwrap();
        assert_eq!(reopened.kind, Some(WorkspaceKind::AgentSpace));
        let ordinary_root = dir.path().join("ordinary");
        std::fs::create_dir(&ordinary_root).unwrap();
        let ordinary = spaces.open(&ordinary_root, None).await.unwrap();
        let ordering_error = spaces
            .move_layout(&ordinary.id, Some(&project.id), Some(&promoted.id))
            .await
            .unwrap_err();
        assert!(
            format!("{ordering_error:#}").contains("cannot be used as an ordering anchor"),
            "a target which cannot be persisted must fail explicitly"
        );
        assert!(spaces.remove(&promoted.id).await.is_err());
        assert!(spaces.move_layout(&promoted.id, None, None).await.is_err());
        assert!(spaces
            .remove_agent_space(&promoted.id, "s_other")
            .await
            .is_err());
        let remaining = spaces
            .remove_agent_space(&promoted.id, "s_pm")
            .await
            .unwrap();
        assert!(!remaining
            .iter()
            .any(|workspace| workspace.id == promoted.id));
        let restored = spaces
            .register_agent_space(&source, &project_entry, "s_pm")
            .await
            .unwrap();
        assert_eq!(restored.id, promoted.id);
        assert_eq!(restored.kind, Some(WorkspaceKind::AgentSpace));

        let saved = Config::load(&dir.path().join("config.json")).unwrap();
        let saved = saved
            .workspaces
            .iter()
            .find(|workspace| workspace.id == promoted.id)
            .unwrap();
        assert_eq!(saved.kind, WorkspaceKind::AgentSpace);
        assert_eq!(
            saved
                .agent_space
                .as_ref()
                .map(|binding| binding.controller_session_id.as_str()),
            Some("s_pm")
        );
    }

    #[tokio::test]
    async fn concurrent_opens_of_one_directory_mint_only_one_workspace_id() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let spaces = Arc::new(workspaces(dir.path()).await);

        let (first, second) =
            tokio::join!(spaces.open(&project, None), spaces.open(&project, None));
        assert_eq!(first.unwrap().id, second.unwrap().id);
        assert_eq!(spaces.list().await.len(), 1);
        assert_eq!(spaces.catalog().await.revision, 1);
    }

    #[tokio::test]
    async fn failed_persistence_never_leaks_an_uncommitted_catalog_revision() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config = Arc::new(RwLock::new(Config::default()));
        let config_path = dir.path().join("config.json");
        crate::config::fail_next_private_save(&config_path);
        let spaces = Workspaces::new(config.clone(), config_path, WorkspaceHomes::default());

        assert!(spaces.open(&project, None).await.is_err());
        assert!(spaces.list().await.is_empty());
        assert!(config.read().await.workspaces.is_empty());
        assert_eq!(spaces.catalog().await.revision, 0);
    }

    #[tokio::test]
    async fn failed_rename_persistence_keeps_the_previous_name_and_revision() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config = Arc::new(RwLock::new(Config::default()));
        let config_path = dir.path().join("config.json");
        let spaces = Workspaces::new(
            config.clone(),
            config_path.clone(),
            WorkspaceHomes::default(),
        );
        let opened = spaces.open(&project, None).await.unwrap();
        crate::config::fail_next_private_save(&config_path);

        assert!(spaces.rename(&opened.id, "not-persisted").await.is_err());
        assert_eq!(spaces.get(&opened.id).await.unwrap().name, "project");
        assert_eq!(config.read().await.workspace_catalog_revision, 1);
        assert_eq!(spaces.catalog().await.revision, 1);
    }

    #[tokio::test]
    async fn failed_remove_persistence_keeps_the_workspace_active() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config = Arc::new(RwLock::new(Config::default()));
        let config_path = dir.path().join("config.json");
        let spaces = Workspaces::new(
            config.clone(),
            config_path.clone(),
            WorkspaceHomes::default(),
        );
        let opened = spaces.open(&project, None).await.unwrap();
        crate::config::fail_next_private_save(&config_path);

        assert!(spaces.remove(&opened.id).await.is_err());
        assert_eq!(spaces.get(&opened.id).await.unwrap().id, opened.id);
        assert!(!config.read().await.workspaces[0].removed);
        assert_eq!(spaces.catalog().await.revision, 1);
    }

    #[tokio::test]
    async fn a_git_checkout_is_reported_as_one() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join(".git")).unwrap();
        let spaces = workspaces(dir.path()).await;
        assert!(spaces.open(dir.path(), None).await.unwrap().is_git_repo);
    }

    #[tokio::test]
    async fn opening_something_that_is_not_there_fails_clearly() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = workspaces(dir.path()).await;
        let error = spaces
            .open(&dir.path().join("missing"), None)
            .await
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("no such folder or workspace file"));
    }

    #[test]
    fn directory_picker_lists_folders_workspace_files_and_can_move_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("project")).unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a folder").unwrap();
        std::fs::write(
            dir.path().join("product.code-workspace"),
            "{\"folders\":[]}",
        )
        .unwrap();

        let listing = list_directory(Some(dir.path())).unwrap();
        assert_eq!(listing.directories.len(), 1);
        assert_eq!(listing.directories[0].name, "project");
        assert_eq!(listing.workspace_files.len(), 1);
        assert_eq!(listing.workspace_files[0].name, "product.code-workspace");
        assert!(!listing.roots);
        let expected_parent = dir
            .path()
            .parent()
            .unwrap()
            .canonicalize()
            .unwrap()
            .display()
            .to_string();
        assert_eq!(listing.parent.as_deref(), Some(expected_parent.as_str()));
    }

    #[test]
    fn directory_picker_empty_path_lists_machine_roots() {
        let listing = list_directory(Some(Path::new(""))).unwrap();
        assert!(listing.roots);
        assert_eq!(listing.path, "");
        assert!(listing.parent.is_none());
        assert!(!listing.directories.is_empty());
        #[cfg(windows)]
        assert!(listing
            .directories
            .iter()
            .any(|entry| entry.path.ends_with(":\\") || entry.path.ends_with(':')));
        #[cfg(not(windows))]
        assert!(listing.directories.iter().any(|entry| entry.path == "/"));
    }

    #[test]
    fn directory_picker_can_create_a_folder_and_refresh_the_parent() {
        let dir = tempfile::tempdir().unwrap();
        let listing = mkdir_directory(dir.path(), "fresh-project").unwrap();
        assert!(dir.path().join("fresh-project").is_dir());
        assert!(listing
            .directories
            .iter()
            .any(|entry| entry.name == "fresh-project"));
    }

    #[tokio::test]
    async fn resolution_is_confined_to_the_workspace_root() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join("a/b/c")).unwrap();
        std::fs::write(project.join("a/b/c/report.md"), "# deep\n").unwrap();
        let spaces = workspaces(dir.path()).await;
        let info = spaces.open(&project, None).await.unwrap();
        let root_handle = &info.folders[0].root_handle;

        assert!(spaces
            .resolve(&info.id, &format!("{root_handle}/src/main.rs"))
            .await
            .is_ok());
        assert!(spaces
            .resolve(&info.id, &format!("{root_handle}/../outside"))
            .await
            .is_err());
        assert!(spaces.resolve(&info.id, "/etc/passwd").await.is_err());
        let deep = spaces
            .resolve(&info.id, &format!("{root_handle}/a/b/c/report.md"))
            .await
            .unwrap();
        assert_eq!(deep.relative, PathBuf::from("a/b/c/report.md"));
    }

    #[tokio::test]
    async fn a_code_workspace_exposes_ordered_roots_and_virtual_paths() {
        let dir = tempfile::tempdir().unwrap();
        let product = dir.path().join("product");
        let docs = dir.path().join("docs");
        std::fs::create_dir(&product).unwrap();
        std::fs::create_dir(&docs).unwrap();
        std::fs::write(product.join("main.unknown-source"), "fn main() {}\n").unwrap();
        std::fs::write(docs.join("guide.md"), "# Guide\n").unwrap();
        let definition = dir.path().join("suite.code-workspace");
        std::fs::write(
            &definition,
            r#"{
              // The first folder remains the Agent working directory.
              folders: [
                { name: "Product", path: "product" },
                { name: "Docs", path: "docs" },
              ],
              settings: { "files.exclude": { "generated": true } },
            }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;

        let opened = spaces.open(&definition, None).await.unwrap();
        assert_eq!(opened.name, "suite");
        assert_eq!(
            opened.root,
            product.canonicalize().unwrap().display().to_string()
        );
        assert_eq!(
            opened
                .folders
                .iter()
                .map(|folder| folder.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Product", "Docs"]
        );
        let product_handle = opened.folders[0].root_handle.clone();
        let docs_handle = opened.folders[1].root_handle.clone();
        assert!(product_handle.starts_with("r_"));
        assert!(docs_handle.starts_with("r_"));
        assert_ne!(product_handle, docs_handle);
        let expected_definition = definition.canonicalize().unwrap().display().to_string();
        assert_eq!(
            opened.workspace_file.as_deref(),
            Some(expected_definition.as_str())
        );

        let root = spaces.tree(&opened.id, None, 1).await.unwrap();
        let children = root.children.unwrap();
        assert_eq!(
            children
                .iter()
                .map(|node| node.name.as_str())
                .collect::<Vec<_>>(),
            vec!["Product", "Docs"]
        );
        assert_eq!(children[0].path, product_handle);
        assert!(children[0].children.is_none());

        let docs_tree = spaces
            .tree(&opened.id, Some(&docs_handle), 1)
            .await
            .unwrap();
        assert_eq!(docs_tree.path, docs_handle);
        assert_eq!(
            docs_tree.children.unwrap()[0].path,
            format!("{docs_handle}/guide.md")
        );

        let source = spaces
            .resolve(&opened.id, &format!("{product_handle}/main.unknown-source"))
            .await
            .unwrap();
        assert_eq!(source.root, product.canonicalize().unwrap());
        assert_eq!(source.relative, PathBuf::from("main.unknown-source"));
        assert!(spaces
            .resolve(&opened.id, "main.unknown-source")
            .await
            .is_err());
        assert!(spaces
            .resolve(&opened.id, &format!("{docs_handle}/../../outside"))
            .await
            .is_err());

        let reopened = spaces.open(&definition, None).await.unwrap();
        assert_eq!(reopened.id, opened.id);
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn a_workspace_file_and_its_agent_root_are_distinct_projects_over_one_root() {
        let dir = tempfile::tempdir().unwrap();
        let product = dir.path().join("product");
        let docs = dir.path().join("docs");
        std::fs::create_dir(&product).unwrap();
        std::fs::create_dir(&docs).unwrap();
        let definition = dir.path().join("suite.code-workspace");
        std::fs::write(
            &definition,
            r#"{ folders: [{ path: "product" }, { path: "docs" }] }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;

        let folder = spaces.open(&product, None).await.unwrap();
        spaces.rename(&folder.id, "Core").await.unwrap();
        let multi_root = spaces.open(&definition, None).await.unwrap();

        assert_ne!(multi_root.id, folder.id);
        assert_eq!(multi_root.name, "suite");
        assert_eq!(
            multi_root.workspace_file.as_deref(),
            Some(
                definition
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            )
        );
        assert_eq!(multi_root.folders.len(), 2);
        assert_eq!(
            multi_root.folders[0].root_handle, folder.folders[0].root_handle,
            "one physical root keeps one device-wide handle"
        );
        assert_eq!(spaces.list().await.len(), 2);

        let plain_again = spaces.open(&product, None).await.unwrap();
        assert_eq!(plain_again.id, folder.id);
        assert_eq!(plain_again.name, "Core");
        assert!(plain_again.workspace_file.is_none());
        assert_eq!(plain_again.folders.len(), 1);
    }

    #[tokio::test]
    async fn reopening_a_workspace_file_refreshes_its_roots_without_changing_identity() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["product", "docs", "tests"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let definition = dir.path().join("suite.code-workspace");
        std::fs::write(
            &definition,
            r#"{ folders: [{ path: "product" }, { path: "docs" }] }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;
        let first = spaces.open(&definition, None).await.unwrap();

        std::fs::write(
            &definition,
            r#"{ folders: [{ path: "product" }, { path: "tests" }] }"#,
        )
        .unwrap();
        let refreshed = spaces.open(&definition, None).await.unwrap();

        assert_eq!(refreshed.id, first.id);
        assert_eq!(refreshed.folders[1].name, "tests");
        assert_eq!(spaces.catalog().await.revision, 1);
    }

    #[tokio::test]
    async fn changing_the_agent_root_creates_a_new_identity_instead_of_moving_history() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["product", "replacement"] {
            std::fs::create_dir(dir.path().join(name)).unwrap();
        }
        let definition = dir.path().join("suite.code-workspace");
        std::fs::write(&definition, r#"{ folders: [{ path: "product" }] }"#).unwrap();
        let spaces = workspaces(dir.path()).await;
        let first = spaces.open(&definition, None).await.unwrap();

        std::fs::write(&definition, r#"{ folders: [{ path: "replacement" }] }"#).unwrap();
        let moved = spaces.open(&definition, None).await.unwrap();

        assert_ne!(moved.id, first.id);
        assert_ne!(moved.root, first.root);
        assert_eq!(spaces.list().await.len(), 2);
    }

    #[tokio::test]
    async fn a_code_workspace_rejects_remote_uri_roots() {
        let dir = tempfile::tempdir().unwrap();
        let definition = dir.path().join("remote.code-workspace");
        std::fs::write(
            &definition,
            r#"{ folders: [{ uri: "vscode-remote://ssh-remote+host/project" }] }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;

        let error = spaces.open(&definition, None).await.unwrap_err();
        assert!(error.to_string().contains("local path entries only"));
        assert!(spaces.list().await.is_empty());
    }

    #[tokio::test]
    async fn configured_labels_do_not_participate_in_root_identity() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("one")).unwrap();
        std::fs::create_dir(dir.path().join("two")).unwrap();
        let definition = dir.path().join("labels.code-workspace");
        std::fs::write(
            &definition,
            r#"{ folders: [
              { name: "Root", path: "one" },
              { name: "Root", path: "two" },
            ] }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;

        let opened = spaces.open(&definition, None).await.unwrap();
        assert_eq!(opened.folders[0].name, "Root");
        assert_eq!(opened.folders[1].name, "Root");
        assert_ne!(opened.folders[0].root_handle, opened.folders[1].root_handle);

        let duplicate = dir.path().join("duplicate.code-workspace");
        std::fs::write(
            &duplicate,
            r#"{ folders: [{ path: "one" }, { path: "./one" }] }"#,
        )
        .unwrap();
        let error = spaces.open(&duplicate, None).await.unwrap_err();
        assert!(error.to_string().contains("same folder more than once"));
    }

    #[tokio::test]
    async fn changing_a_workspace_folder_label_does_not_change_resource_paths() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let definition = dir.path().join("labels.code-workspace");
        std::fs::write(
            &definition,
            r#"{ folders: [{ name: "Frontend", path: "project" }] }"#,
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;
        let first = spaces.open(&definition, None).await.unwrap();
        let handle = first.folders[0].root_handle.clone();

        std::fs::write(
            &definition,
            r#"{ folders: [{ name: "Web UI", path: "project" }] }"#,
        )
        .unwrap();
        let reopened = spaces.open(&definition, None).await.unwrap();

        assert_eq!(reopened.id, first.id);
        assert_eq!(reopened.folders[0].name, "Web UI");
        assert_eq!(reopened.folders[0].root_handle, handle);
        assert!(spaces
            .resolve(&reopened.id, &format!("{handle}/nested/file.txt"))
            .await
            .is_ok());
    }

    #[tokio::test]
    async fn a_code_workspace_rejects_more_than_the_small_root_limit() {
        let dir = tempfile::tempdir().unwrap();
        let mut folders = Vec::new();
        for index in 0..=MAX_WORKSPACE_FOLDERS {
            let name = format!("root-{index}");
            std::fs::create_dir(dir.path().join(&name)).unwrap();
            folders.push(serde_json::json!({ "path": name }));
        }
        let definition = dir.path().join("too-many.code-workspace");
        std::fs::write(
            &definition,
            serde_json::to_vec(&serde_json::json!({ "folders": folders })).unwrap(),
        )
        .unwrap();
        let spaces = workspaces(dir.path()).await;

        let error = spaces.open(&definition, None).await.unwrap_err();
        assert!(error.to_string().contains("above the 32 folder limit"));
        assert!(spaces.list().await.is_empty());
    }

    #[tokio::test]
    async fn a_machine_that_has_never_been_used_still_has_somewhere_to_work() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = workspaces(dir.path()).await;
        let root = dir.path().join("GeneHub");

        let created = spaces.ensure_default(&root).await.unwrap();
        assert!(root.is_dir(), "the folder is made, not just named");
        assert_eq!(created.name, "GeneHub");
        assert_eq!(spaces.list().await.len(), 1);

        // Restarting must not add a second one.
        let again = spaces.ensure_default(&root).await.unwrap();
        assert_eq!(again.id, created.id);
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn a_user_with_their_own_project_is_not_given_a_default_one() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let spaces = workspaces(dir.path()).await;
        let mine = spaces.open(&project, None).await.unwrap();

        let root = dir.path().join("GeneHub");
        assert_eq!(spaces.ensure_default(&root).await.unwrap().id, mine.id);
        assert!(!root.exists(), "nothing is created behind the user's back");
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn an_unknown_workspace_id_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = workspaces(dir.path()).await;
        assert!(spaces.get("nope").await.is_err());
    }

    #[tokio::test]
    async fn a_workspace_name_is_trimmed_and_persisted() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config = Arc::new(RwLock::new(Config::default()));
        let spaces = Workspaces::new(
            config.clone(),
            dir.path().join("config.json"),
            WorkspaceHomes::default(),
        );
        let opened = spaces.open(&project, None).await.unwrap();

        let renamed = spaces.rename(&opened.id, "  我的项目  ").await.unwrap();

        assert_eq!(renamed.name, "我的项目");
        assert_eq!(spaces.list().await[0].name, "我的项目");
        assert_eq!(config.read().await.workspaces[0].name, "我的项目");
        let saved = Config::load(&dir.path().join("config.json")).unwrap();
        assert_eq!(saved.workspaces[0].name, "我的项目");
    }

    #[tokio::test]
    async fn a_workspace_cannot_be_renamed_to_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = workspaces(dir.path()).await;
        let opened = spaces.open(dir.path(), None).await.unwrap();

        assert!(spaces.rename(&opened.id, "   ").await.is_err());
        assert_eq!(spaces.list().await[0].name, opened.name);
    }

    #[tokio::test]
    async fn removing_a_workspace_retains_files_history_and_identity_for_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        let session = project.join(".genethub/sessions/s_1/meta.json");
        std::fs::create_dir_all(session.parent().unwrap()).unwrap();
        std::fs::write(&session, "conversation stays here").unwrap();
        let config = Arc::new(RwLock::new(Config::default()));
        let config_path = dir.path().join("config.json");
        let spaces = Workspaces::new(
            config.clone(),
            config_path.clone(),
            WorkspaceHomes::default(),
        );
        let opened = spaces.open(&project, None).await.unwrap();

        assert!(spaces.remove(&opened.id).await.unwrap().is_empty());
        assert!(spaces.list().await.is_empty());
        assert!(spaces.catalog().await.workspaces.is_empty());
        assert!(spaces.get(&opened.id).await.is_err());
        assert_eq!(
            std::fs::read_to_string(&session).unwrap(),
            "conversation stays here"
        );
        assert!(Config::load(&config_path).unwrap().workspaces[0].removed);

        let reopened = spaces.open(&project, None).await.unwrap();
        assert_eq!(reopened.id, opened.id);
        assert_eq!(spaces.list().await.len(), 1);
        assert!(!config.read().await.workspaces[0].removed);
    }

    #[tokio::test]
    async fn a_removed_last_workspace_does_not_recreate_the_default_on_restart() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let spaces = workspaces(dir.path()).await;
        let opened = spaces.open(&project, None).await.unwrap();
        spaces.remove(&opened.id).await.unwrap();

        let default = dir.path().join("GeneHub");
        let retained = spaces.ensure_default(&default).await.unwrap();
        assert_eq!(retained.id, opened.id);
        assert!(!default.exists());
        assert!(spaces.list().await.is_empty());
    }

    #[tokio::test]
    async fn the_hub_catalog_contains_no_local_paths_and_has_a_stable_order() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("first-secret-path");
        let second = dir.path().join("second-secret-path");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        let config = Arc::new(RwLock::new(Config {
            workspace_catalog_generation: "wcg_test".into(),
            ..Config::default()
        }));
        let spaces = Workspaces::new(
            config,
            dir.path().join("config.json"),
            WorkspaceHomes::default(),
        );
        spaces.open(&second, Some("Second".into())).await.unwrap();
        spaces.open(&first, Some("First".into())).await.unwrap();

        let catalog = spaces.catalog().await;
        assert_eq!(catalog.generation, "wcg_test");
        assert_eq!(catalog.revision, 2);
        assert_eq!(catalog.workspaces.len(), 2);
        assert!(catalog
            .workspaces
            .windows(2)
            .all(|pair| pair[0].local_workspace_id < pair[1].local_workspace_id));
        let wire = serde_json::to_string(&catalog).unwrap();
        assert!(!wire.contains("secret-path"));
        assert!(!wire.contains("root"));
    }

    #[tokio::test]
    async fn one_unsafe_local_name_cannot_block_the_complete_hub_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let config = Arc::new(RwLock::new(Config {
            workspace_catalog_generation: "wcg_test".into(),
            workspace_roots: vec![crate::config::WorkspaceRootEntry {
                handle: "r_project".into(),
                root: project.clone(),
            }],
            workspaces: vec![WorkspaceEntry {
                id: "w_unsafe12345678".into(),
                name: "  looks-safe\u{202e}but-is-not  ".into(),
                kind: WorkspaceKind::Folder,
                agent_space: None,
                root: project.clone(),
                folders: vec![WorkspaceFolderEntry {
                    name: "project".into(),
                    root: project,
                    root_handle: "r_project".into(),
                }],
                workspace_file: None,
                removed: false,
                is_git_repo: false,
            }],
            ..Config::default()
        }));
        let spaces = Workspaces::new(
            config,
            dir.path().join("config.json"),
            WorkspaceHomes::default(),
        );
        spaces.load().await;

        let catalog = spaces.catalog().await;
        assert_eq!(catalog.workspaces[0].reported_name, "Workspace · 12345678");
        assert!(!catalog.workspaces[0]
            .reported_name
            .chars()
            .any(char::is_control));
    }

    #[tokio::test]
    async fn catalog_revision_changes_only_when_the_catalog_changes() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        std::fs::create_dir(&project).unwrap();
        let spaces = workspaces(dir.path()).await;

        let opened = spaces.open(&project, None).await.unwrap();
        assert_eq!(spaces.catalog().await.revision, 1);
        spaces.open(&project, None).await.unwrap();
        assert_eq!(spaces.catalog().await.revision, 1);
        spaces.rename(&opened.id, "project").await.unwrap();
        assert_eq!(spaces.catalog().await.revision, 1);
        spaces.rename(&opened.id, "renamed").await.unwrap();
        assert_eq!(spaces.catalog().await.revision, 2);
    }
}
