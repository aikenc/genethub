//! Registered project roots. Every file and git call is scoped to one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::{DirectoryEntry, DirectoryListing, WorkspaceInfo};
use tokio::sync::RwLock;

use crate::config::{Config, WorkspaceEntry};

const MAX_DIRECTORY_ENTRIES: usize = 2000;

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

    let mut directories = std::fs::read_dir(&path)
        .with_context(|| format!("could not read {}", path.display()))?
        .take(MAX_DIRECTORY_ENTRIES)
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            entry
                .file_type()
                .ok()
                .filter(|kind| kind.is_dir())
                .map(|_| DirectoryEntry {
                    name: entry.file_name().to_string_lossy().to_string(),
                    path: entry.path().display().to_string(),
                })
        })
        .collect::<Vec<_>>();
    directories.sort_by_key(|entry| entry.name.to_lowercase());

    Ok(DirectoryListing {
        path: path.display().to_string(),
        parent: path.parent().map(|parent| parent.display().to_string()),
        directories,
    })
}

impl Workspaces {
    pub fn new(config: Arc<RwLock<Config>>, config_path: PathBuf) -> Self {
        Workspaces {
            entries: RwLock::new(HashMap::new()),
            config_path,
            config,
        }
    }

    pub async fn load(&self) {
        let mut entries = self.entries.write().await;
        for entry in &self.config.read().await.workspaces {
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

    /// Resolves a workspace-relative path, refusing anything outside the root.
    pub async fn resolve(&self, workspace_id: &str, relative: &str) -> Result<PathBuf> {
        let entry = self.get(workspace_id).await?;
        crate::session::ensure_within(&entry.root, Path::new(relative))
    }

    /// Registers a root, or returns the existing entry if it is already known.
    ///
    /// Opening the same folder twice is a normal thing for a user to do and
    /// should not produce two entries pointing at one directory.
    pub async fn open(&self, root: &Path, name: Option<String>) -> Result<WorkspaceInfo> {
        let root = root
            .canonicalize()
            .with_context(|| format!("no such directory: {}", root.display()))?;
        if !root.is_dir() {
            return Err(anyhow!("{} is not a directory", root.display()));
        }

        // Keep the write lock from the duplicate check through commit. Two
        // concurrent WorkspaceOpen calls for the same canonical path must not
        // mint two local ids (and therefore two Hub workspaces).
        let mut entries = self.entries.write().await;
        if let Some(existing) = entries.values().find(|entry| entry.root == root) {
            return Ok(describe(existing));
        }

        let entry = WorkspaceEntry {
            id: format!("w_{}", uuid::Uuid::new_v4().simple()),
            name: name.unwrap_or_else(|| {
                root.file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_else(|| root.display().to_string())
            }),
            root: root.clone(),
            is_git_repo: root.join(".git").exists(),
        };
        let mut config = self.config.write().await;
        let mut next = config.clone();
        next.workspaces.push(entry.clone());
        next.workspace_catalog_revision = next.workspace_catalog_revision.saturating_add(1);
        // Publish to memory only after the durable snapshot exists. Otherwise
        // the background Hub sync could upload a revision that restart loses.
        next.save(&self.config_path)?;
        *config = next;
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
    }
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
        Workspaces::new(config, dir.join("config.json"))
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
        let spaces = Workspaces::new(config.clone(), config_path);

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
        let spaces = Workspaces::new(config.clone(), config_path.clone());
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
        assert!(error.to_string().contains("no such directory"));
    }

    #[test]
    fn directory_picker_lists_only_folders_and_can_move_up() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("project")).unwrap();
        std::fs::write(dir.path().join("notes.txt"), "not a folder").unwrap();

        let listing = list_directory(Some(dir.path())).unwrap();
        assert_eq!(listing.directories.len(), 1);
        assert_eq!(listing.directories[0].name, "project");
        assert_eq!(
            listing.parent.as_deref(),
            dir.path()
                .parent()
                .map(|path| path.to_string_lossy())
                .as_deref()
        );
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
        let spaces = Workspaces::new(config.clone(), dir.path().join("config.json"));
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
        let spaces = Workspaces::new(config, dir.path().join("config.json"));
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
                root: project,
                is_git_repo: false,
            }],
            ..Config::default()
        }));
        let spaces = Workspaces::new(config, dir.path().join("config.json"));
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
