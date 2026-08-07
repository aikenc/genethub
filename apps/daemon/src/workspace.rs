//! Registered project roots. Every file and git call is scoped to one.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{
    DirectoryEntry, DirectoryListing, FileNode, WorkspaceFolderInfo, WorkspaceInfo,
};
use serde::Deserialize;
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
    pub path_prefix: String,
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
        for entry in &self.config.read().await.workspaces {
            debug_assert!(!entry.folders.is_empty());
            self.homes.attach(&entry.id, &entry.root);
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
        if let Some(existing) = self.list().await.into_iter().next() {
            return Ok(existing);
        }
        std::fs::create_dir_all(root)
            .with_context(|| format!("creating the default workspace at {}", root.display()))?;
        self.open(root, None).await
    }

    pub async fn list(&self) -> Vec<WorkspaceInfo> {
        let mut out: Vec<WorkspaceInfo> =
            self.entries.read().await.values().map(describe).collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// A stable, path-free snapshot suitable for account-wide discovery.
    pub async fn catalog(&self) -> WorkspaceCatalog {
        let entries = self.entries.read().await;
        let mut workspaces: Vec<CatalogWorkspace> = entries
            .values()
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
        self.entries
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow!("no such workspace: {id}"))
    }

    /// Resolves a virtual workspace path to one concrete root. Plain folder
    /// workspaces keep their historic unprefixed paths; `.code-workspace`
    /// roots use the folder's stable first segment.
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
                                &folder.path_prefix,
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

        let requested = path.unwrap_or(".");
        let resolved = resolve_entry(&entry, requested)?;
        crate::files::tree_with_prefix(
            &resolved.root,
            &resolved.absolute,
            depth,
            &resolved.path_prefix,
            if resolved.relative.as_os_str().is_empty() {
                entry
                    .folders
                    .iter()
                    .find(|folder| folder.path_prefix == resolved.path_prefix)
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

        // Keep the write lock from the duplicate check through commit. Two
        // concurrent WorkspaceOpen calls for the same canonical path must not
        // mint two local ids (and therefore two Hub workspaces).
        let mut entries = self.entries.write().await;
        if let Some(existing) = entries
            .values()
            .find(|entry| same_workspace_source(entry, &candidate))
        {
            return Ok(describe(existing));
        }

        let entry = candidate;
        let mut config = self.config.write().await;
        let mut next = config.clone();
        next.workspaces.push(entry.clone());
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        // Publish to memory only after the durable snapshot exists. Otherwise
        // the background Hub sync could upload a revision that restart loses.
        next.save(&self.config_path)?;
        *config = next;
        self.homes.attach(&entry.id, &entry.root);
        entries.insert(entry.id.clone(), entry.clone());

        Ok(describe(&entry))
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
                path_prefix: folder.path_prefix.clone(),
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
            path_prefix: String::new(),
        }],
        workspace_file: None,
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
    let mut prefixes = HashSet::new();
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
        let path_prefix = unique_path_prefix(&name, &mut prefixes);
        folders.push(WorkspaceFolderEntry {
            name,
            root,
            path_prefix,
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

fn unique_path_prefix(name: &str, used: &mut HashSet<String>) -> String {
    let mut base = String::new();
    for character in name.chars() {
        let replacement =
            character.is_control() || matches!(character, '/' | '\\' | ':' | '#' | '?');
        base.push(if replacement { '-' } else { character });
        if base.len() >= 180 {
            break;
        }
    }
    let base = base.trim_matches(|character| matches!(character, ' ' | '.'));
    let base = if base.is_empty() || matches!(base, "." | "..") {
        "folder"
    } else {
        base
    };
    let mut candidate = base.to_string();
    let mut suffix = 2;
    while !used.insert(candidate.clone()) {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }
    candidate
}

fn same_workspace_source(existing: &WorkspaceEntry, candidate: &WorkspaceEntry) -> bool {
    match (&existing.workspace_file, &candidate.workspace_file) {
        (Some(existing), Some(candidate)) => existing == candidate,
        (None, None) => existing.root == candidate.root,
        _ => false,
    }
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
    let (folder, relative) = if entry.workspace_file.is_some() {
        if matches!(virtual_path, "" | ".") {
            anyhow::bail!("the multi-root workspace itself is not a filesystem directory");
        }
        let (prefix, tail) = virtual_path
            .split_once('/')
            .map_or((virtual_path, ""), |(prefix, tail)| (prefix, tail));
        let folder = entry
            .folders
            .iter()
            .find(|folder| folder.path_prefix == prefix)
            .ok_or_else(|| anyhow!("no such workspace folder: {prefix}"))?;
        (folder, tail)
    } else {
        let folder = entry
            .folders
            .first()
            .ok_or_else(|| anyhow!("workspace has no folders"))?;
        (folder, virtual_path)
    };
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
        path_prefix: folder.path_prefix.clone(),
    })
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
        std::fs::create_dir(&project).unwrap();
        let spaces = workspaces(dir.path()).await;
        let info = spaces.open(&project, None).await.unwrap();

        assert!(spaces.resolve(&info.id, "src/main.rs").await.is_ok());
        assert!(spaces.resolve(&info.id, "../outside").await.is_err());
        assert!(spaces.resolve(&info.id, "/etc/passwd").await.is_err());
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
                .map(|folder| (folder.name.as_str(), folder.path_prefix.as_str()))
                .collect::<Vec<_>>(),
            vec![("Product", "Product"), ("Docs", "Docs")]
        );
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
        assert_eq!(children[0].path, "Product");
        assert!(children[0].children.is_none());

        let docs_tree = spaces.tree(&opened.id, Some("Docs"), 1).await.unwrap();
        assert_eq!(docs_tree.path, "Docs");
        assert_eq!(docs_tree.children.unwrap()[0].path, "Docs/guide.md");

        let source = spaces
            .resolve(&opened.id, "Product/main.unknown-source")
            .await
            .unwrap();
        assert_eq!(source.root, product.canonicalize().unwrap());
        assert_eq!(source.relative, PathBuf::from("main.unknown-source"));
        assert!(spaces
            .resolve(&opened.id, "main.unknown-source")
            .await
            .is_err());
        assert!(spaces
            .resolve(&opened.id, "Docs/../../outside")
            .await
            .is_err());

        let reopened = spaces.open(&definition, None).await.unwrap();
        assert_eq!(reopened.id, opened.id);
        assert_eq!(spaces.list().await.len(), 1);
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
    async fn a_code_workspace_disambiguates_labels_and_rejects_duplicate_roots() {
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
        assert_eq!(opened.folders[0].path_prefix, "Root");
        assert_eq!(opened.folders[1].path_prefix, "Root-2");

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
            workspaces: vec![WorkspaceEntry {
                id: "w_unsafe12345678".into(),
                name: "  looks-safe\u{202e}but-is-not  ".into(),
                root: project.clone(),
                folders: vec![WorkspaceFolderEntry {
                    name: "project".into(),
                    root: project,
                    path_prefix: String::new(),
                }],
                workspace_file: None,
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
