//! Registered project roots. Every file and git call is scoped to one.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use genehub_proto::WorkspaceInfo;
use tokio::sync::RwLock;

use crate::config::{Config, WorkspaceEntry};

pub struct Workspaces {
    entries: RwLock<HashMap<String, WorkspaceEntry>>,
    config_path: PathBuf,
    config: Arc<RwLock<Config>>,
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

    pub async fn list(&self) -> Vec<WorkspaceInfo> {
        let mut out: Vec<WorkspaceInfo> = self
            .entries
            .read()
            .await
            .values()
            .map(describe)
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
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

        if let Some(existing) = self
            .entries
            .read()
            .await
            .values()
            .find(|entry| entry.root == root)
        {
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
        };
        self.entries
            .write()
            .await
            .insert(entry.id.clone(), entry.clone());

        let mut config = self.config.write().await;
        config.workspaces.push(entry.clone());
        config.save(&self.config_path)?;

        Ok(describe(&entry))
    }
}

fn describe(entry: &WorkspaceEntry) -> WorkspaceInfo {
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        root: entry.root.display().to_string(),
        is_git_repo: entry.root.join(".git").exists(),
    }
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
    async fn an_unknown_workspace_id_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let spaces = workspaces(dir.path()).await;
        assert!(spaces.get("nope").await.is_err());
    }
}
