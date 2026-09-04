//! Registered project roots. Every file and git call is scoped to one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    AgentSpaceOperation, DirectoryEntry, DirectoryListing, FileNode, WorkspaceFolderInfo,
    WorkspaceInfo,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::config::{AgentSpaceEntry, Config, WorkspaceEntry, WorkspaceFolderEntry};
use crate::session::WorkspaceHomes;

const MAX_DIRECTORY_ENTRIES: usize = 2000;
const MAX_WORKSPACE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WORKSPACE_FOLDERS: usize = 32;

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
                attach_project_home(&self.homes, entry);
            }
            entries.insert(entry.id.clone(), entry.clone());
        }
        drop(config);
        self.collapse_same_directory_projects(&mut entries).await;
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
        let mut out: Vec<WorkspaceInfo> = entries
            .values()
            .filter(|entry| !entry.removed)
            .map(|entry| self.describe_with_space(entry, &config))
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
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

    /// Resolves a Workspace that may own a project DCG.
    ///
    /// Unregistered folders remain accepted for V1 migration. Once an
    /// AgentSpace registration exists, only a project root is an entry: which
    /// components it mounts is deliberately irrelevant to this decision, so a
    /// Space that both manages the project and executes nodes still qualifies.
    /// Registered Spaces are reverified here so a drifted Builder projection
    /// cannot mutate or execute the project's control graph.
    pub async fn project_entry(&self, id: &str) -> Result<WorkspaceEntry> {
        let entries = self.entries.read().await;
        let entry = entries
            .get(id)
            .filter(|entry| !entry.removed)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        let config = self.config.read().await;
        if let Some(space) = config
            .agent_spaces
            .iter()
            .find(|space| space.workspace_id == id)
        {
            if space.parent_workspace_id.is_some() {
                anyhow::bail!("子 AgentSpace 不能作为项目 DCG 入口；请回到项目根 AgentSpace");
            }
            verify_pipe_space(&entry)?;
        }
        hydrate_entry(entry, &config.workspace_roots)
    }

    /// The current registration, or a revision-zero placeholder for a folder
    /// that has never been registered. Callers compare `revision` before they
    /// act, so "not registered yet" and "registered at revision 1" have to be
    /// the same shape.
    pub async fn agent_space(&self, workspace_id: &str) -> Result<AgentSpaceEntry> {
        let config = self.config.read().await;
        Ok(existing_or_unregistered(&config, workspace_id))
    }

    /// The project this Space belongs to, which is the topmost ancestor in the
    /// ownership tree. An unregistered or detached Space is its own project.
    pub async fn project_root(&self, workspace_id: &str) -> Result<String> {
        let config = self.config.read().await;
        Ok(crate::agent_space::project_root(
            &config.agent_spaces,
            workspace_id,
        ))
    }

    /// Applies one operation to an already-open, PipeBuilder-verified
    /// AgentSpace under a compare-and-set on the registration revision.
    ///
    /// The lock digest is re-verified on every call, not just at first
    /// registration: a Space whose generated projection has drifted must not
    /// be able to gain a responsibility or move in the tree.
    pub async fn configure_agent_space(
        &self,
        workspace_id: &str,
        expected_revision: u64,
        operation: &AgentSpaceOperation,
    ) -> Result<WorkspaceInfo> {
        let entries = self.entries.read().await;
        let entry = entries
            .get(workspace_id)
            .filter(|entry| !entry.removed)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {workspace_id}"))?;
        let lock_digest = verify_pipe_space(&entry)?;
        if let AgentSpaceOperation::SetParent {
            parent_workspace_id: Some(parent_id),
        } = operation
        {
            let parent = entries
                .get(parent_id.as_str())
                .filter(|entry| !entry.removed)
                .ok_or_else(|| anyhow!("no such parent workspace: {parent_id}"))?;
            verify_pipe_space(parent)?;
        }
        drop(entries);

        let mut config = self.config.write().await;
        let current = existing_or_unregistered(&config, workspace_id);
        if current.revision != expected_revision {
            anyhow::bail!(
                "AgentSpace {workspace_id} is at revision {}, not {expected_revision}",
                current.revision
            );
        }
        let mut proposed = crate::agent_space::apply(&current, operation)?;
        proposed.builder_lock_digest = lock_digest;
        proposed.revision = current.revision.saturating_add(1);
        crate::agent_space::check_tree(&config.agent_spaces, &proposed)?;

        let mut next = config.clone();
        match next
            .agent_spaces
            .iter_mut()
            .find(|space| space.workspace_id == workspace_id)
        {
            Some(existing) => *existing = proposed,
            None => next.agent_spaces.push(proposed),
        }
        next.save(&self.config_path)?;
        *config = next;
        Ok(self.describe_with_space(&entry, &config))
    }

    fn describe_with_space(&self, entry: &WorkspaceEntry, config: &Config) -> WorkspaceInfo {
        let mut info = describe(entry);
        apply_space_projection(&mut info, config);
        info
    }

    /// Resolves the one reusable child Space that mounts `component_id` for
    /// this project, and revalidates both identities at the moment the child
    /// is bound to work.
    ///
    /// Direct children only: a grandchild belongs to a subteam's own
    /// scheduling boundary, and a Space with no registration at all keeps the
    /// pre-AgentSpace in-place path so existing directory projects still run.
    pub async fn reusable_component_space(
        &self,
        project_workspace_id: &str,
        component_id: &str,
    ) -> Result<Option<WorkspaceEntry>> {
        // Workspace mutations consistently acquire entries before config.
        // Preserve that order here so an open/remove cannot deadlock against
        // a concurrent Workflow dispatch.
        let entries = self.entries.read().await;
        let config = self.config.read().await;
        let project = match config
            .agent_spaces
            .iter()
            .find(|space| space.workspace_id == project_workspace_id)
        {
            None => return Ok(None), // pre-AgentSpace project; migration remains possible
            Some(space) if space.parent_workspace_id.is_none() => space,
            Some(_) => anyhow::bail!("Workflow dispatch requires a project-root AgentSpace"),
        };
        let matches = config
            .agent_spaces
            .iter()
            .filter(|space| {
                space.parent_workspace_id.as_deref() == Some(project_workspace_id)
                    && crate::agent_space::has_enabled_component(space, component_id)
                    && space.lifecycle != "ephemeral"
            })
            .cloned()
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            anyhow::bail!(
                "project AgentSpace must have exactly one reusable {component_id} child; found {}",
                matches.len()
            );
        }
        let relation = &matches[0];
        let child = entries
            .get(&relation.workspace_id)
            .filter(|entry| !entry.removed)
            .cloned()
            .ok_or_else(|| anyhow!("registered {component_id} AgentSpace is not open"))?;
        let current_digest = verify_pipe_space(&child)?;
        if current_digest != relation.builder_lock_digest {
            anyhow::bail!("registered {component_id} AgentSpace changed since project binding");
        }
        let project_entry = entries
            .get(&project.workspace_id)
            .filter(|entry| !entry.removed)
            .ok_or_else(|| anyhow!("project AgentSpace is not open"))?;
        let project_digest = verify_pipe_space(project_entry)?;
        if project_digest != project.builder_lock_digest {
            anyhow::bail!("project AgentSpace changed since project binding");
        }
        Ok(Some(child))
    }

    /// The direct children this Space may dispatch to, refusing outright when
    /// it does not mount an enabled `executor`.
    ///
    /// Structure and scheduling are separate questions on one tree: being
    /// somebody's parent is ownership, and only the executor component is
    /// permission to command.
    pub async fn schedulable_children(
        &self,
        executor_workspace_id: &str,
    ) -> Result<Vec<WorkspaceInfo>> {
        let entries = self.entries.read().await;
        let config = self.config.read().await;
        let executor = config
            .agent_spaces
            .iter()
            .find(|space| space.workspace_id == executor_workspace_id)
            .ok_or_else(|| anyhow!("no such AgentSpace: {executor_workspace_id}"))?;
        if !crate::agent_space::has_enabled_component(
            executor,
            crate::agent_space::COMPONENT_EXECUTOR,
        ) {
            anyhow::bail!("this AgentSpace does not mount an enabled executor component");
        }
        Ok(
            crate::agent_space::schedulable_children(&config.agent_spaces, executor_workspace_id)
                .into_iter()
                .filter_map(|space| {
                    entries
                        .get(&space.workspace_id)
                        .filter(|entry| !entry.removed)
                        .map(|entry| self.describe_with_space(entry, &config))
                })
                .collect(),
        )
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

        // Keep the write lock from the source identity check through commit.
        // A `.code-workspace` file belongs to the directory that contains it,
        // not to whichever folder happens to be listed first and not to the
        // file path as a third identity. Opening that directory and opening
        // the file are the same project.
        let mut entries = self.entries.write().await;
        let mut config = self.config.write().await;
        let mut next = config.clone();
        let mut candidate = candidate;
        for folder in &mut candidate.folders {
            folder.root_handle = next.ensure_workspace_root(&folder.root);
        }
        if let Some(existing) = existing_project(&entries, &candidate).cloned() {
            let mut updated = candidate;
            updated.id = existing.id.clone();
            // The label belongs to the durable project identity, not whichever
            // folder/workspace-file view most recently opened it. In particular,
            // switching views must not erase a name the user chose.
            updated.name = existing.name.clone();
            updated.removed = false;
            if updated == existing {
                return Ok(self.describe_with_space(&existing, &config));
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
            attach_project_home(&self.homes, &updated);
            entries.insert(updated.id.clone(), updated.clone());
            return Ok(self.describe_with_space(&updated, &config));
        }

        let entry = candidate;
        next.workspaces.push(entry.clone());
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        // Publish to memory only after the durable snapshot exists. Otherwise
        // the background Hub sync could upload a revision that restart loses.
        next.save(&self.config_path)?;
        *config = next;
        attach_project_home(&self.homes, &entry);
        entries.insert(entry.id.clone(), entry.clone());

        Ok(self.describe_with_space(&entry, &config))
    }

    /// Removes a project from the active registry without touching its files or
    /// conversations. The durable entry is a tombstone with enough identity to
    /// reactivate the same id when the source is opened again.
    pub async fn remove(&self, id: &str) -> Result<Vec<WorkspaceInfo>> {
        let mut entries = self.entries.write().await;
        let entry = entries
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        if entry.removed {
            let config = self.config.read().await;
            return Ok(active_descriptions(entries.values(), &config));
        }
        let config_snapshot = self.config.read().await;
        let has_active_children = config_snapshot.agent_spaces.iter().any(|space| {
            space.parent_workspace_id.as_deref() == Some(id)
                && entries
                    .get(&space.workspace_id)
                    .is_some_and(|child| !child.removed)
        });
        drop(config_snapshot);
        if has_active_children {
            anyhow::bail!("remove or re-parent this AgentSpace's children first");
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

        Ok(active_descriptions(entries.values(), &config))
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

        Ok(self.describe_with_space(&updated, &config))
    }

    /// One directory is one project. A leftover folder entry and a
    /// `.code-workspace` file that lives in that folder used to be two ids;
    /// keep the file entry (it already has the richer view) and tombstone the
    /// rest so the sidebar stops listing the same project twice.
    async fn collapse_same_directory_projects(
        &self,
        entries: &mut HashMap<String, WorkspaceEntry>,
    ) {
        let mut groups: HashMap<PathBuf, Vec<String>> = HashMap::new();
        for entry in entries.values().filter(|entry| !entry.removed) {
            groups
                .entry(project_directory(entry))
                .or_default()
                .push(entry.id.clone());
        }
        let extras: Vec<String> = groups
            .into_values()
            .filter(|ids| ids.len() > 1)
            .flat_map(|mut ids| {
                ids.sort();
                let keep = ids
                    .iter()
                    .find(|id| {
                        entries
                            .get(*id)
                            .is_some_and(|entry| entry.workspace_file.is_some())
                    })
                    .cloned()
                    .unwrap_or_else(|| ids[0].clone());
                ids.into_iter().filter(move |id| id != &keep)
            })
            .collect();
        if extras.is_empty() {
            return;
        }

        let mut config = self.config.write().await;
        let mut next = config.clone();
        for id in extras {
            if let Some(entry) = entries.get_mut(&id) {
                entry.removed = true;
            }
            if let Some(saved) = next.workspaces.iter_mut().find(|entry| entry.id == id) {
                saved.removed = true;
            }
            self.homes.detach(&id);
        }
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        if next.save(&self.config_path).is_err() {
            return;
        }
        *config = next;
    }
}

fn active_descriptions<'a>(
    entries: impl Iterator<Item = &'a WorkspaceEntry>,
    config: &Config,
) -> Vec<WorkspaceInfo> {
    let mut out: Vec<_> = entries
        .filter(|entry| !entry.removed)
        .map(|entry| {
            let mut info = describe(entry);
            apply_space_projection(&mut info, config);
            info
        })
        .collect();
    out.sort_by(|left, right| left.name.cmp(&right.name));
    out
}

/// The registration this Workspace carries, plus the older exclusive-role
/// view derived from it. One lookup, one truth, two shapes on the wire.
fn apply_space_projection(info: &mut WorkspaceInfo, config: &Config) {
    let Some(space) = config
        .agent_spaces
        .iter()
        .find(|space| space.workspace_id == info.id)
    else {
        return;
    };
    info.agent_space = Some(crate::agent_space::describe(space));
    info.pipe_space = Some(crate::agent_space::describe_legacy(space));
}

/// A folder with no registration answers the same questions as a registered
/// one, at revision zero. Callers therefore never branch on "does a
/// registration exist" before they can compare-and-set.
fn existing_or_unregistered(config: &Config, workspace_id: &str) -> AgentSpaceEntry {
    config
        .agent_spaces
        .iter()
        .find(|space| space.workspace_id == workspace_id)
        .cloned()
        .unwrap_or_else(|| AgentSpaceEntry {
            workspace_id: workspace_id.to_string(),
            parent_workspace_id: None,
            revision: 0,
            lifecycle: "persistent".into(),
            builder_lock_digest: String::new(),
            components: Vec::new(),
        })
}

fn describe(entry: &WorkspaceEntry) -> WorkspaceInfo {
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
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
        workspace_file: entry
            .workspace_file
            .as_ref()
            .map(|path| path.display().to_string()),
        agent_space: None,
        pipe_space: None,
    }
}

fn file_digest(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    Ok(format!("sha256:{:x}", Sha256::digest(bytes)))
}

/// Verify the frozen lock-owned PipeSpace projection without executing a
/// Provider: manifest/workspace identity and every generated artifact must
/// still match the lock.
fn verify_pipe_space(entry: &WorkspaceEntry) -> Result<String> {
    let root = entry
        .root
        .canonicalize()
        .context("PipeSpace root is unavailable")?;
    let manifest_path = root.join("pipespace.json");
    let lock_path = root.join(".pipebuilder/lock.json");
    if std::fs::symlink_metadata(&manifest_path)?
        .file_type()
        .is_symlink()
        || std::fs::symlink_metadata(&lock_path)?
            .file_type()
            .is_symlink()
    {
        anyhow::bail!("PipeSpace manifest and lock must be regular files");
    }
    let lock: serde_json::Value = serde_json::from_slice(&std::fs::read(&lock_path)?)
        .context("parsing PipeBuilder ownership lock")?;
    if lock.get("schema").and_then(|value| value.as_str()) != Some("pipebuilder-lock.v1") {
        anyhow::bail!("unsupported PipeBuilder ownership lock");
    }
    let space = lock
        .get("pipespace")
        .and_then(|value| value.as_object())
        .ok_or_else(|| anyhow!("PipeBuilder lock has no PipeSpace identity"))?;
    let manifest_digest = file_digest(&manifest_path)?;
    if space.get("manifestDigest").and_then(|value| value.as_str())
        != Some(manifest_digest.as_str())
    {
        anyhow::bail!("pipespace.json drifted from the PipeBuilder lock");
    }
    let workspace_name = space
        .get("workspace")
        .and_then(|value| value.as_str())
        .ok_or_else(|| anyhow!("PipeBuilder lock has no workspace identity"))?;
    if Path::new(workspace_name).components().count() != 1 {
        anyhow::bail!("PipeBuilder workspace identity must be a file name");
    }
    let workspace_path = root.join(workspace_name);
    let workspace_digest = file_digest(&workspace_path)?;
    if std::fs::symlink_metadata(&workspace_path)?
        .file_type()
        .is_symlink()
        || space
            .get("workspaceDigest")
            .and_then(|value| value.as_str())
            != Some(workspace_digest.as_str())
    {
        anyhow::bail!("PipeSpace workspace drifted from the PipeBuilder lock");
    }
    let artifacts = lock
        .get("artifacts")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow!("PipeBuilder lock has no artifact list"))?;
    for artifact in artifacts {
        let target = artifact
            .get("target")
            .and_then(|value| value.as_str())
            .ok_or_else(|| anyhow!("PipeBuilder artifact has no target"))?;
        let target_relative = Path::new(target);
        if target_relative.is_absolute()
            || target_relative.components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            anyhow::bail!("PipeBuilder artifact has an unsafe target: {target}");
        }
        let target_path = root.join(target);
        let target_digest = file_digest(&target_path)?;
        let resolved_target = target_path
            .canonicalize()
            .with_context(|| format!("resolving PipeBuilder artifact {target}"))?;
        if std::fs::symlink_metadata(&target_path)?
            .file_type()
            .is_symlink()
            || !resolved_target.starts_with(&root)
            || artifact.get("digest").and_then(|value| value.as_str())
                != Some(target_digest.as_str())
        {
            anyhow::bail!("PipeBuilder artifact drifted: {target}");
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let expected_executable = artifact
                .get("executable")
                .and_then(|value| value.as_bool())
                .unwrap_or(false);
            let actual_executable =
                std::fs::metadata(&target_path)?.permissions().mode() & 0o111 != 0;
            if actual_executable != expected_executable {
                anyhow::bail!("PipeBuilder artifact executable mode drifted: {target}");
            }
        }
    }
    file_digest(&lock_path)
}

fn folder_workspace(root: PathBuf, name: Option<String>) -> WorkspaceEntry {
    let folder_name = root
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());
    WorkspaceEntry {
        id: format!("w_{}", uuid::Uuid::new_v4().simple()),
        name: name.unwrap_or_else(|| folder_name.clone()),
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

fn attach_project_home(homes: &WorkspaceHomes, entry: &WorkspaceEntry) {
    homes.attach_project_aliased(
        &entry.id,
        &session_project_key(entry),
        &legacy_project_keys(entry),
        &entry.root,
    );
}

fn existing_project<'a>(
    entries: &'a HashMap<String, WorkspaceEntry>,
    candidate: &WorkspaceEntry,
) -> Option<&'a WorkspaceEntry> {
    entries
        .values()
        .filter(|entry| same_project_source(entry, candidate))
        .min_by_key(|entry| {
            (
                entry.removed,
                entry.workspace_file.is_none(),
                entry.id.as_str(),
            )
        })
}

/// The directory that owns this project's conversations.
///
/// A folder open is that folder. A `.code-workspace` file is the directory
/// that contains the file, not the first root and not the file path.
fn project_directory(entry: &WorkspaceEntry) -> PathBuf {
    match &entry.workspace_file {
        Some(path) => path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| entry.root.clone()),
        None => entry.root.clone(),
    }
}

fn same_project_source(left: &WorkspaceEntry, right: &WorkspaceEntry) -> bool {
    project_directory(left) == project_directory(right)
}

fn session_project_key(entry: &WorkspaceEntry) -> String {
    match &entry.workspace_file {
        None => "folder".to_string(),
        Some(path) => {
            let home = path.parent().unwrap_or(path);
            if home == entry.root {
                "folder".to_string()
            } else {
                hashed_workspace_key(home)
            }
        }
    }
}

fn legacy_project_keys(entry: &WorkspaceEntry) -> Vec<String> {
    match &entry.workspace_file {
        Some(path) => {
            let hashed = hashed_workspace_key(path);
            let current = session_project_key(entry);
            if hashed != current {
                vec![hashed]
            } else {
                Vec::new()
            }
        }
        None => Vec::new(),
    }
}

fn hashed_workspace_key(path: &Path) -> String {
    let mut digest = Sha256::new();
    digest.update(b"genehub-workspace-source-v1\0");
    update_path_digest(&mut digest, path);
    format!("workspace:{:x}", digest.finalize())
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

    fn write_verified_pipe_space(root: &Path, name: &str) {
        std::fs::create_dir_all(root.join(".pipebuilder")).unwrap();
        let manifest = root.join("pipespace.json");
        let workspace = root.join(format!("{name}.code-workspace"));
        std::fs::write(
            &manifest,
            format!(r#"{{"schema":"pipespace.v1","name":"{name}"}}"#),
        )
        .unwrap();
        std::fs::write(&workspace, r#"{"folders":[{"path":"."}]}"#).unwrap();
        let lock = serde_json::json!({
            "schema": "pipebuilder-lock.v1",
            "pipespace": {
                "name": name,
                "manifestDigest": file_digest(&manifest).unwrap(),
                "workspace": workspace.file_name().unwrap().to_string_lossy(),
                "workspaceDigest": file_digest(&workspace).unwrap()
            },
            "artifacts": []
        });
        std::fs::write(
            root.join(".pipebuilder/lock.json"),
            serde_json::to_vec(&lock).unwrap(),
        )
        .unwrap();
    }

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
        assert_eq!(spaces.project_entry(&first.id).await.unwrap().id, first.id);
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
    async fn a_workspace_file_in_its_directory_is_the_same_project_as_that_folder() {
        let dir = tempfile::tempdir().unwrap();
        let definition = dir.path().join("release-beta.code-workspace");
        std::fs::write(&definition, r#"{ folders: [{ path: "." }] }"#).unwrap();
        let spaces = workspaces(dir.path()).await;

        let folder = spaces.open(dir.path(), None).await.unwrap();
        spaces.rename(&folder.id, "Release").await.unwrap();
        let from_file = spaces.open(&definition, None).await.unwrap();

        assert_eq!(from_file.id, folder.id);
        assert_eq!(from_file.name, "Release");
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn changing_the_first_root_keeps_the_workspace_file_identity() {
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

        assert_eq!(moved.id, first.id);
        assert_eq!(
            moved.root,
            dir.path()
                .join("replacement")
                .canonicalize()
                .unwrap()
                .display()
                .to_string()
        );
        assert_eq!(spaces.list().await.len(), 1);
    }

    #[tokio::test]
    async fn load_collapses_a_folder_and_workspace_file_in_the_same_directory() {
        let dir = tempfile::tempdir().unwrap();
        let definition = dir.path().join("suite.code-workspace");
        std::fs::write(&definition, r#"{ folders: [{ path: "." }] }"#).unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = definition.canonicalize().unwrap();
        let config = Arc::new(RwLock::new(Config {
            workspace_roots: vec![crate::config::WorkspaceRootEntry {
                handle: "r_root".into(),
                root: root.clone(),
            }],
            workspaces: vec![
                WorkspaceEntry {
                    id: "w_folderaaaaaaaa".into(),
                    name: "release-beta".into(),
                    root: root.clone(),
                    folders: vec![WorkspaceFolderEntry {
                        name: "release-beta".into(),
                        root: root.clone(),
                        root_handle: "r_root".into(),
                    }],
                    workspace_file: None,
                    removed: false,
                    is_git_repo: false,
                },
                WorkspaceEntry {
                    id: "w_filebbbbbbbbbb".into(),
                    name: "suite".into(),
                    root: root.clone(),
                    folders: vec![WorkspaceFolderEntry {
                        name: "release-beta".into(),
                        root,
                        root_handle: "r_root".into(),
                    }],
                    workspace_file: Some(file),
                    removed: false,
                    is_git_repo: false,
                },
            ],
            ..Config::default()
        }));
        let spaces = Workspaces::new(
            config,
            dir.path().join("config.json"),
            WorkspaceHomes::default(),
        );
        spaces.load().await;

        let listed = spaces.list().await;
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "w_filebbbbbbbbbb");
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

    /// Opens the named directories as verified AgentSpaces and returns their
    /// workspace ids in the order given.
    async fn open_verified(dir: &Path, names: &[&str]) -> (Workspaces, Vec<String>) {
        for name in names {
            write_verified_pipe_space(&dir.join(name), name);
        }
        let spaces = workspaces(dir).await;
        let mut ids = Vec::new();
        for name in names {
            ids.push(spaces.open(&dir.join(name), None).await.unwrap().id);
        }
        (spaces, ids)
    }

    /// Mounts one enabled component at whatever revision the Space is on.
    /// Tests that care about the compare-and-set call the RPC surface
    /// directly with an explicit revision instead.
    async fn mount(
        spaces: &Workspaces,
        workspace_id: &str,
        component_id: &str,
        role: Option<&str>,
    ) -> Result<WorkspaceInfo> {
        let revision = spaces.agent_space(workspace_id).await?.revision;
        spaces
            .configure_agent_space(
                workspace_id,
                revision,
                &AgentSpaceOperation::SetComponent {
                    component_id: component_id.into(),
                    enabled: true,
                    role: role.map(str::to_string),
                },
            )
            .await
    }

    async fn attach(
        spaces: &Workspaces,
        workspace_id: &str,
        parent: &str,
    ) -> Result<WorkspaceInfo> {
        let revision = spaces.agent_space(workspace_id).await?.revision;
        spaces
            .configure_agent_space(
                workspace_id,
                revision,
                &AgentSpaceOperation::SetParent {
                    parent_workspace_id: Some(parent.to_string()),
                },
            )
            .await
    }

    async fn set_lifecycle(
        spaces: &Workspaces,
        workspace_id: &str,
        lifecycle: &str,
    ) -> Result<WorkspaceInfo> {
        let revision = spaces.agent_space(workspace_id).await?.revision;
        spaces
            .configure_agent_space(
                workspace_id,
                revision,
                &AgentSpaceOperation::SetLifecycle {
                    lifecycle: lifecycle.into(),
                },
            )
            .await
    }

    #[tokio::test]
    async fn project_and_reusable_executor_are_registered_as_mounted_components() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project", "executor"]).await;
        let (project, executor) = (ids[0].clone(), ids[1].clone());

        mount(&spaces, &project, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap();
        attach(&spaces, &executor, &project).await.unwrap();
        mount(
            &spaces,
            &executor,
            crate::agent_space::COMPONENT_EXECUTOR,
            None,
        )
        .await
        .unwrap();
        set_lifecycle(&spaces, &executor, "pooled").await.unwrap();

        let listed = spaces.list().await;
        let find = |id: &str| {
            listed
                .iter()
                .find(|workspace| workspace.id == id)
                .unwrap()
                .clone()
        };
        let project_space = find(&project).agent_space.unwrap();
        assert!(project_space.parent_workspace_id.is_none());
        assert_eq!(
            project_space
                .components
                .iter()
                .map(|component| component.component_id.as_str())
                .collect::<Vec<_>>(),
            vec![crate::agent_space::COMPONENT_PM]
        );
        assert!(find(&project).pipe_space.unwrap().pm);

        let executor_space = find(&executor).agent_space.unwrap();
        assert_eq!(
            executor_space.parent_workspace_id.as_deref(),
            Some(project.as_str())
        );
        assert_eq!(executor_space.lifecycle, "pooled");
        assert_eq!(
            executor_space.revision, 3,
            "attach, mount and lifecycle each advance the one registration revision"
        );
        assert_eq!(
            find(&executor).pipe_space.unwrap().worker_role.as_deref(),
            Some(crate::agent_space::LEGACY_EXECUTOR_ROLE),
            "the older exclusive-role shape is still readable"
        );

        let first = spaces
            .reusable_component_space(&project, crate::agent_space::COMPONENT_EXECUTOR)
            .await
            .unwrap()
            .unwrap();
        let second = spaces
            .reusable_component_space(&project, crate::agent_space::COMPONENT_EXECUTOR)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.id, executor);
        assert_eq!(
            second.id, executor,
            "a later Run reuses the same execution carrier"
        );
        assert_eq!(
            spaces.project_entry(&project).await.unwrap().id,
            project,
            "a project root owns its DCG"
        );
        let error = spaces.project_entry(&executor).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("子 AgentSpace 不能作为项目 DCG 入口"));
    }

    #[tokio::test]
    async fn one_space_can_manage_the_project_and_drive_the_flow() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project"]).await;
        let project = ids[0].clone();

        mount(&spaces, &project, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap();
        let info = mount(
            &spaces,
            &project,
            crate::agent_space::COMPONENT_EXECUTOR,
            None,
        )
        .await
        .unwrap();

        assert_eq!(info.agent_space.as_ref().unwrap().components.len(), 2);
        assert_eq!(
            spaces.project_entry(&project).await.unwrap().id,
            project,
            "mounting the executor component does not cost a project root its DCG"
        );
    }

    #[tokio::test]
    async fn a_subteam_owns_its_own_workers_and_the_project_cannot_reach_past_it() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project", "team", "coder"]).await;
        let (project, team, coder) = (ids[0].clone(), ids[1].clone(), ids[2].clone());

        mount(
            &spaces,
            &project,
            crate::agent_space::COMPONENT_EXECUTOR,
            None,
        )
        .await
        .unwrap();
        attach(&spaces, &team, &project).await.unwrap();
        mount(
            &spaces,
            &team,
            crate::agent_space::COMPONENT_WORKER,
            Some("coder"),
        )
        .await
        .unwrap();
        mount(&spaces, &team, crate::agent_space::COMPONENT_EXECUTOR, None)
            .await
            .unwrap();
        attach(&spaces, &coder, &team).await.unwrap();
        mount(
            &spaces,
            &coder,
            crate::agent_space::COMPONENT_WORKER,
            Some("coder"),
        )
        .await
        .unwrap();

        assert_eq!(
            spaces
                .schedulable_children(&project)
                .await
                .unwrap()
                .iter()
                .map(|space| space.id.clone())
                .collect::<Vec<_>>(),
            vec![team.clone()],
            "the project sees the subteam itself, never the subteam's Workers"
        );
        assert_eq!(
            spaces
                .schedulable_children(&team)
                .await
                .unwrap()
                .iter()
                .map(|space| space.id.clone())
                .collect::<Vec<_>>(),
            vec![coder.clone()]
        );
        let error = spaces.schedulable_children(&coder).await.unwrap_err();
        assert!(
            error.to_string().contains("enabled executor component"),
            "a Worker cannot enumerate anything: {error}"
        );
    }

    #[tokio::test]
    async fn structure_alone_never_grants_the_right_to_dispatch() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project", "coder"]).await;
        let (project, coder) = (ids[0].clone(), ids[1].clone());

        mount(&spaces, &project, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap();
        attach(&spaces, &coder, &project).await.unwrap();
        mount(
            &spaces,
            &coder,
            crate::agent_space::COMPONENT_WORKER,
            Some("coder"),
        )
        .await
        .unwrap();

        let error = spaces.schedulable_children(&project).await.unwrap_err();
        assert!(
            error.to_string().contains("enabled executor component"),
            "being the parent is ownership, not permission to command: {error}"
        );
    }

    #[tokio::test]
    async fn configuration_requires_the_revision_the_caller_read() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project"]).await;
        let project = ids[0].clone();

        mount(&spaces, &project, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap();
        let error = spaces
            .configure_agent_space(
                &project,
                0,
                &AgentSpaceOperation::SetComponent {
                    component_id: crate::agent_space::COMPONENT_EXECUTOR.into(),
                    enabled: true,
                    role: None,
                },
            )
            .await
            .unwrap_err();

        assert!(
            error.to_string().contains("is at revision 1, not 0"),
            "a caller working from a stale read is told so: {error}"
        );
        assert_eq!(
            spaces.agent_space(&project).await.unwrap().components.len(),
            1,
            "the refused call left nothing behind"
        );
    }

    #[tokio::test]
    async fn an_unregistered_folder_reports_a_revision_zero_registration() {
        let dir = tempfile::tempdir().unwrap();
        let plain = dir.path().join("plain");
        std::fs::create_dir(&plain).unwrap();
        let spaces = workspaces(dir.path()).await;
        let plain = spaces.open(&plain, None).await.unwrap();

        let space = spaces.agent_space(&plain.id).await.unwrap();
        assert_eq!(space.revision, 0);
        assert!(space.components.is_empty());
        assert!(
            plain.agent_space.is_none() && plain.pipe_space.is_none(),
            "an ordinary folder stays a neutral filesystem fact on the wire"
        );
        assert!(
            spaces
                .reusable_component_space(&plain.id, crate::agent_space::COMPONENT_EXECUTOR)
                .await
                .unwrap()
                .is_none(),
            "a directory project keeps the pre-AgentSpace in-place path"
        );
    }

    #[tokio::test]
    async fn registration_rejects_pipespace_artifact_drift() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("project");
        write_verified_pipe_space(&project, "project");
        std::fs::write(project.join("pipespace.json"), "{}\n").unwrap();
        let spaces = workspaces(dir.path()).await;
        let project = spaces.open(&project, None).await.unwrap();
        let error = mount(&spaces, &project.id, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap_err();
        assert!(error.to_string().contains("drifted"));
    }

    #[tokio::test]
    async fn a_drifted_space_cannot_gain_a_further_responsibility() {
        let dir = tempfile::tempdir().unwrap();
        let (spaces, ids) = open_verified(dir.path(), &["project"]).await;
        let project = ids[0].clone();
        mount(&spaces, &project, crate::agent_space::COMPONENT_PM, None)
            .await
            .unwrap();

        std::fs::write(dir.path().join("project/pipespace.json"), "{}\n").unwrap();
        let error = mount(
            &spaces,
            &project,
            crate::agent_space::COMPONENT_EXECUTOR,
            None,
        )
        .await
        .unwrap_err();

        assert!(
            error.to_string().contains("drifted"),
            "the lock is re-verified on every change, not only at registration: {error}"
        );
    }
}
