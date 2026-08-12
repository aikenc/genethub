//! Registered project roots. Every file and git call is scoped to one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    DirectoryEntry, DirectoryListing, FileNode, WorkspaceFolderInfo, WorkspaceInfo,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::config::{Config, WorkspaceEntry, WorkspaceFolderEntry};
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

pub fn list_directory(requested: Option<&Path>) -> Result<DirectoryListing> {
    let path = requested
        .map(Path::to_path_buf)
        .or_else(dirs::home_dir)
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
        parent: path.parent().map(|parent| parent.display().to_string()),
        directories,
        workspace_files,
    })
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
        let mut out: Vec<WorkspaceInfo> = self
            .entries
            .read()
            .await
            .values()
            .filter(|entry| !entry.removed)
            .map(describe)
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
        let mut entries = self.entries.write().await;
        let entry = entries
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))?;
        if entry.removed {
            return Ok(active_descriptions(entries.values()));
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

        Ok(active_descriptions(entries.values()))
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

fn active_descriptions<'a>(
    entries: impl Iterator<Item = &'a WorkspaceEntry>,
) -> Vec<WorkspaceInfo> {
    let mut out: Vec<_> = entries
        .filter(|entry| !entry.removed)
        .map(describe)
        .collect();
    out.sort_by(|left, right| left.name.cmp(&right.name));
    out
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
    }
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
        let requested = PathBuf::from(raw);
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
