//! Machine-local file locators and directory scopes for restricted access.
//!
//! The catalogue is a source of roots, never an identity embedded in a v3
//! locator. A scoped peer and a share still intersect this machine policy.
use crate::{config::Config, state::Shared, workspace::ResolvedWorkspacePath};
use anyhow::{anyhow, bail, Result};
use genehub_proto::{FileAccessDirectory, FileAccessInfo, WorkspaceFileSource};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Component, Path, PathBuf},
};

/// Windows volume/reparse semantics need a real Host qualification before
/// enabling the new address format. Existing v2 access remains available.
pub fn machine_files_supported() -> bool {
    cfg!(target_family = "wasm") && !crate::guest_paths::windows_host()
}

pub fn display(path: &Path) -> String {
    let native = crate::guest_paths::host_form(&path.to_string_lossy()).into_owned();
    native
        .strip_prefix(r"\\?\")
        .unwrap_or(&native)
        .replace('\\', "/")
}

/// Do not let drive-relative, device, alternate-stream or dot paths acquire
/// meaning from the server's working directory. POSIX names retain ':' etc.
pub fn absolute(raw: &str) -> Result<PathBuf> {
    if raw.is_empty() || raw.len() > 4096 || raw.contains('\0') {
        bail!("invalid absolute file path");
    }
    let windows = crate::guest_paths::windows_host();
    if windows
        && (raw.starts_with("\\\\")
            || raw.starts_with("//")
            || (raw.as_bytes().get(1) == Some(&b':')
                && !matches!(raw.as_bytes().get(2), Some(b'/') | Some(b'\\'))))
    {
        bail!("UNC, device and drive-relative paths are not supported");
    }
    if !windows && raw.contains('\\') {
        bail!("invalid POSIX path separator");
    }
    let path = crate::guest_paths::inbound_absolute(Path::new(raw))
        .ok_or_else(|| anyhow!("file path must be absolute"))?;
    // Path::components normalizes '.', so check spelling before components.
    if raw
        .replace('\\', "/")
        .split('/')
        .any(|p| p == "." || p == "..")
    {
        bail!("file path must be canonical");
    }
    if windows
        && path.components().any(|p| match p {
            Component::Normal(name) => {
                let name = name.to_string_lossy();
                let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
                name.contains(':')
                    || name.ends_with(['.', ' '])
                    || matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                    || (stem.len() == 4
                        && (stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.as_bytes()[3].is_ascii_digit())
            }
            _ => false,
        })
    {
        bail!("invalid Windows file name");
    }
    Ok(path)
}

fn relative_to(path: &Path, root: &Path) -> Option<PathBuf> {
    let normalized_root = absolute(&display(root)).ok()?;
    let root = normalized_root.as_path();
    let path_parts: Vec<_> = path.components().collect();
    let root_parts: Vec<_> = root.components().collect();
    if root_parts.len() >= path_parts.len() {
        return None;
    }
    let windows = crate::guest_paths::windows_host();
    if !root_parts.iter().zip(&path_parts).all(|(a, b)| {
        if windows {
            a.as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
        } else {
            a == b
        }
    }) {
        return None;
    }
    Some(
        path_parts[root_parts.len()..]
            .iter()
            .map(|c| c.as_os_str())
            .collect(),
    )
}

pub fn info(config: &Config) -> FileAccessInfo {
    let mut directories = BTreeMap::<String, FileAccessDirectory>::new();
    for workspace in config.workspaces.iter().filter(|w| !w.removed) {
        for folder in &workspace.folders {
            let path = display(&folder.root);
            let entry = directories
                .entry(path.clone())
                .or_insert(FileAccessDirectory {
                    absolute_path: path,
                    workspace_ids: Vec::new(),
                    additional: false,
                });
            if !entry.workspace_ids.contains(&workspace.id) {
                entry.workspace_ids.push(workspace.id.clone());
            }
        }
    }
    let additional_directories: Vec<_> = config
        .file_access
        .additional_directories
        .iter()
        .map(|p| display(p))
        .collect();
    for path in &additional_directories {
        directories
            .entry(path.clone())
            .or_insert(FileAccessDirectory {
                absolute_path: path.clone(),
                workspace_ids: Vec::new(),
                additional: false,
            })
            .additional = true;
    }
    let mut directories: Vec<_> = directories.into_values().collect();
    for entry in &mut directories {
        entry.workspace_ids.sort();
    }
    let digest = Sha256::digest(
        serde_json::to_vec(&(config.file_access.revision, &directories))
            .expect("serializable directory catalogue"),
    );
    FileAccessInfo {
        revision: format!("{digest:x}"),
        directories,
        additional_directories,
    }
}

pub async fn configure(
    state: &Shared,
    expected: &str,
    paths: Vec<String>,
) -> Result<FileAccessInfo> {
    if paths.len() > 256 {
        bail!("at most 256 additional directories");
    }
    let mut roots = Vec::new();
    for raw in paths {
        let path = absolute(&raw)?;
        let canonical = std::fs::canonicalize(path)?;
        if !canonical.is_dir() {
            bail!("additional path is not a directory");
        }
        if !roots.contains(&canonical) {
            roots.push(canonical);
        }
    }
    roots.sort();
    let mut config = state.config.write().await;
    if info(&config).revision != expected {
        bail!("file access revision conflict; reload the directory list");
    }
    let mut next = config.clone();
    next.file_access.additional_directories = roots;
    next.file_access.revision = next
        .file_access
        .revision
        .checked_add(1)
        .ok_or_else(|| anyhow!("file access revision exhausted"))?;
    next.save(&state.paths.config_file())?;
    *config = next;
    Ok(info(&config))
}

/// Resolve a machine locator against the current catalogue. No disk search and
/// no cached grant: removing the last root source revokes the next read.
pub async fn resolve(
    state: &Shared,
    raw: &str,
    scope: Option<&str>,
) -> Result<ResolvedWorkspacePath> {
    let path = absolute(raw)?;
    let config = state.config.read().await;
    let mut candidates = Vec::new();
    for workspace in config
        .workspaces
        .iter()
        .filter(|w| !w.removed && scope.is_none_or(|id| w.id == id))
    {
        for folder in &workspace.folders {
            if let Some(relative) = relative_to(&path, &folder.root) {
                if relative.starts_with(std::path::Path::new(".genethub").join("sessions")) {
                    continue;
                }
                candidates.push(ResolvedWorkspacePath {
                    root: folder.root.clone(),
                    absolute: path.clone(),
                    relative,
                    root_handle: folder.root_handle.clone(),
                });
            }
        }
    }
    if scope.is_none() {
        for root in &config.file_access.additional_directories {
            if let Some(relative) = relative_to(&path, root) {
                candidates.push(ResolvedWorkspacePath {
                    root: root.clone(),
                    absolute: path.clone(),
                    relative,
                    root_handle: String::new(),
                });
            }
        }
    }
    candidates.sort_by_key(|r| std::cmp::Reverse(r.root.components().count()));
    candidates
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("file is outside the accessible directories"))
}

pub struct AuthorizedFile {
    pub resolved: ResolvedWorkspacePath,
    source: WorkspaceFileSource,
}

pub(crate) async fn resolve_source(
    state: &Shared,
    workspace: &str,
    path: &str,
) -> Result<ResolvedWorkspacePath> {
    if absolute(path).is_ok() {
        resolve(state, path, (!workspace.is_empty()).then_some(workspace)).await
    } else {
        state.workspaces.resolve(workspace, path).await
    }
}

/// A full connection already has the daemon OS user's authority. Keep the
/// registered root when one exists so existing locators retain their metadata.
pub(crate) async fn resolve_preview_source(
    state: &Shared,
    workspace: &str,
    path: &str,
    caller: &crate::authz::Principal,
) -> Result<ResolvedWorkspacePath> {
    match resolve_source(state, workspace, path).await {
        Ok(file) => Ok(file),
        Err(_) if workspace.is_empty() && caller.is_full() => {
            let absolute = absolute(path)?;
            let root = absolute
                .parent()
                .ok_or_else(|| anyhow!("preview file has no parent"))?;
            let name = absolute
                .file_name()
                .ok_or_else(|| anyhow!("preview file has no name"))?;
            Ok(ResolvedWorkspacePath {
                root: root.to_owned(),
                relative: PathBuf::from(name),
                absolute,
                root_handle: String::new(),
            })
        }
        Err(error) => Err(error),
    }
}

pub async fn authorize(
    state: &Shared,
    access: &crate::dataplane::endpoint::PeerAccess,
    source: &WorkspaceFileSource,
) -> Result<AuthorizedFile> {
    let caller = crate::authz::Principal::of(state, access);
    if !caller.permits_stream(crate::authz::StreamMethod::AssetPreview) {
        bail!("file capability revoked");
    }
    let scope = if matches!(caller, crate::authz::Principal::PreviewShare { .. }) {
        access.workspace_id.as_deref()
    } else {
        None
    };
    let resolved = match source {
        WorkspaceFileSource::WorkspaceFile {
            workspace_handle,
            path,
        } => {
            crate::files::validate_preview_path(path)?;
            let workspace = match (
                access.workspace_id.as_deref(),
                access.workspace_handle.as_deref(),
            ) {
                (Some(id), Some(handle)) if workspace_handle == handle => id,
                _ => workspace_handle.as_str(),
            };
            if scope.is_some_and(|id| id != workspace) {
                bail!("preview workspace mismatch");
            }
            let resolved = state.workspaces.resolve(workspace, path).await?;
            // The v2 adapter intersects the live machine directory policy too.
            resolve(state, &display(&resolved.absolute), Some(workspace)).await?;
            crate::preview_feedback::authorize_asset(state, &caller, workspace, path).await?;
            resolved
        }
        WorkspaceFileSource::MachineFile { absolute_path } => {
            let file = if caller.is_full() {
                resolve_preview_source(state, "", absolute_path, &caller).await
            } else {
                resolve(state, absolute_path, scope).await
            };
            match file {
                Ok(resolved) => {
                    let grant_path = scope
                        .map(|_| {
                            format!(
                                "{}/{}",
                                resolved.root_handle,
                                resolved.relative.to_string_lossy().replace('\\', "/")
                            )
                        })
                        .unwrap_or_else(|| display(&resolved.absolute));
                    crate::preview_feedback::authorize_asset(
                        state,
                        &caller,
                        scope.unwrap_or(""),
                        &grant_path,
                    )
                    .await?;
                    resolved
                }
                Err(_) => {
                    crate::preview_feedback::resolve_evidence(
                        state,
                        &caller,
                        scope,
                        &absolute(absolute_path)?,
                    )
                    .await?
                }
            }
        }
    };
    Ok(AuthorizedFile {
        resolved,
        source: source.clone(),
    })
}

impl AuthorizedFile {
    pub async fn recheck(
        &self,
        state: &Shared,
        access: &crate::dataplane::endpoint::PeerAccess,
    ) -> Result<()> {
        let caller = crate::authz::Principal::of(state, access);
        // Revocation of Files is checked as well as the directory/share lease.
        if !caller.is_full() && !matches!(caller, crate::authz::Principal::PreviewShare { .. }) {
            bail!("file capability revoked");
        }
        authorize(state, access, &self.source).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authz::Principal;

    #[tokio::test]
    async fn full_preview_can_read_an_unregistered_file_but_a_share_cannot_resolve_it() {
        let data = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let state = crate::AppState::build(crate::config::Paths::new(data.path()))
            .await
            .unwrap()
            .0;
        state.workspaces.open(workspace.path(), None).await.unwrap();
        let entry = outside.path().join("index.html");
        std::fs::write(&entry, "<!doctype html><title>Preview</title>").unwrap();
        let path = display(&entry);
        let full = Principal::Device {
            id: "paired".into(),
        };
        let resolved = resolve_preview_source(&state, "", &path, &full)
            .await
            .unwrap();
        assert_eq!(resolved.root, outside.path());
        assert_eq!(resolved.relative, Path::new("index.html"));
        crate::files::preview(&resolved.root, "index.html")
            .await
            .unwrap();
        assert!(crate::static_preview::Site::resolve(resolved).is_ok());

        let share = Principal::PreviewShare { id: "share".into() };
        assert!(resolve_preview_source(&state, "", &path, &share)
            .await
            .is_err());
        let revoked = Principal::RevokedDevice {
            id: "paired".into(),
        };
        assert!(resolve_preview_source(&state, "", &path, &revoked)
            .await
            .is_err());
    }
}
