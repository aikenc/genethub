use std::collections::HashSet;

use genehub_proto::{
    DirectoryEntry, DirectoryListing, ErrorCode, ProtocolError, WorkspaceFolderInfo, WorkspaceInfo,
};
use genet_daemon_logic_api::{
    CapabilityFailureKind, CapabilityRequest, CapabilityValue, FileKind, FileLocator, FileRequest,
    FileRoot,
};
use serde::Deserialize;

use crate::capability::Client;
use crate::config::{Config, WorkspaceEntry, WorkspaceFolderEntry, WorkspaceRootEntry};
use crate::CapabilityExecutor;

const MAX_DIRECTORY_ENTRIES: usize = 2_000;
const MAX_WORKSPACE_FILE_BYTES: u32 = 1024 * 1024;
const MAX_WORKSPACE_FOLDERS: usize = 32;

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

pub fn prepare(
    config: &mut Config,
    default_workspace: Option<&str>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<bool, ProtocolError> {
    let mut changed = false;
    for workspace in &mut config.workspaces {
        if workspace.folders.is_empty() {
            workspace.folders.push(WorkspaceFolderEntry {
                name: native_leaf(&workspace.root),
                root: workspace.root.clone(),
                root_handle: String::new(),
            });
            changed = true;
        }
    }

    let mut roots = config
        .workspace_roots
        .iter()
        .map(|root| (root.root.clone(), root.handle.clone()))
        .collect::<std::collections::BTreeMap<_, _>>();
    for workspace in &mut config.workspaces {
        if workspace.id.trim().is_empty() {
            workspace.id = random_id("w_", executor, next)?;
            changed = true;
        }
        for folder in &mut workspace.folders {
            let handle = if let Some(handle) = roots.get(&folder.root) {
                handle.clone()
            } else {
                let handle = random_id("r_", executor, next)?;
                config.workspace_roots.push(WorkspaceRootEntry {
                    handle: handle.clone(),
                    root: folder.root.clone(),
                });
                roots.insert(folder.root.clone(), handle.clone());
                changed = true;
                handle
            };
            if folder.root_handle != handle {
                folder.root_handle = handle;
                changed = true;
            }
        }
        if let Some(first) = workspace.folders.first() {
            if workspace.root != first.root {
                workspace.root = first.root.clone();
                changed = true;
            }
        }
    }
    if config.workspace_catalog_generation.is_empty() {
        config.workspace_catalog_generation = random_id("wcg_", executor, next)?;
        changed = true;
    }

    if config.workspaces.is_empty() {
        if let Some(default_workspace) = default_workspace {
            let mut client = Client::new(executor, next);
            let _ = client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
                locator: FileLocator {
                    root: FileRoot::NativePath,
                    path: default_workspace.to_string(),
                },
            }))?;
            let entry = folder_candidate(default_workspace.to_string(), None, &mut client)?;
            attach_entry(config, entry, &mut client)?;
            changed = true;
        }
    }

    let mut client = Client::new(executor, next);
    for root in &config.workspace_roots {
        match client.call(CapabilityRequest::File(
            FileRequest::RegisterWorkspaceRoot {
                handle: root.handle.clone(),
                native_path: root.root.clone(),
            },
        ))? {
            CapabilityValue::Text(_) => {}
            _ => {
                return Err(internal(
                    "workspace root registration returned the wrong value",
                ))
            }
        }
    }
    Ok(changed)
}

pub fn list(config: &Config) -> Vec<WorkspaceInfo> {
    let mut workspaces = config
        .workspaces
        .iter()
        .filter(|workspace| !workspace.removed)
        .map(describe)
        .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.name.cmp(&right.name));
    workspaces
}

pub fn open(
    config: &mut Config,
    root: String,
    name: Option<String>,
    create: bool,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<WorkspaceInfo, ProtocolError> {
    let mut client = Client::new(executor, next);
    if create {
        client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
            locator: FileLocator {
                root: FileRoot::NativePath,
                path: root.clone(),
            },
        }))?;
    }
    let canonical = canonicalize(&root, &mut client)?;
    let metadata = metadata(&canonical, &mut client)?;
    let mut candidate = if metadata.kind == FileKind::Directory {
        folder_candidate(canonical, name, &mut client)?
    } else if metadata.kind == FileKind::File
        && metadata
            .extension
            .as_deref()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("code-workspace"))
        && name.is_none()
    {
        code_workspace(canonical, metadata, &mut client)?
    } else {
        return Err(bad_request(format!(
            "{root} is neither a directory nor a .code-workspace file"
        )));
    };

    if let Some(existing) = config
        .workspaces
        .iter()
        .find(|entry| same_project_source(entry, &candidate))
        .cloned()
    {
        candidate.id = existing.id.clone();
        candidate.name = existing.name;
        candidate.removed = false;
        if let Some(saved) = config
            .workspaces
            .iter_mut()
            .find(|entry| entry.id == candidate.id)
        {
            *saved = candidate.clone();
        }
    } else {
        candidate.id = random_id_with_client("w_", &mut client)?;
        config.workspaces.push(candidate.clone());
    }
    attach_roots(config, &mut candidate, &mut client)?;
    if let Some(saved) = config
        .workspaces
        .iter_mut()
        .find(|entry| entry.id == candidate.id)
    {
        *saved = candidate.clone();
    }
    config.workspace_catalog_revision = config.workspace_catalog_revision.saturating_add(1);
    Ok(describe(&candidate))
}

pub fn rename(config: &mut Config, id: &str, name: &str) -> Result<WorkspaceInfo, ProtocolError> {
    let name = clean_name(name)?;
    let workspace = config
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id && !workspace.removed)
        .ok_or_else(|| not_found(format!("no such workspace: {id}")))?;
    if workspace.name != name {
        workspace.name = name;
        config.workspace_catalog_revision = config.workspace_catalog_revision.saturating_add(1);
    }
    Ok(describe(workspace))
}

pub fn remove(config: &mut Config, id: &str) -> Result<Vec<WorkspaceInfo>, ProtocolError> {
    let workspace = config
        .workspaces
        .iter_mut()
        .find(|workspace| workspace.id == id)
        .ok_or_else(|| not_found(format!("no such workspace: {id}")))?;
    if !workspace.removed {
        workspace.removed = true;
        config.workspace_catalog_revision = config.workspace_catalog_revision.saturating_add(1);
    }
    Ok(list(config))
}

pub fn directory(
    requested: Option<String>,
    home: Option<&str>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<DirectoryListing, ProtocolError> {
    if requested.as_deref() == Some("") {
        let mut client = Client::new(executor, next);
        let entries = match client.call(CapabilityRequest::File(FileRequest::MachineRoots))? {
            CapabilityValue::FileEntries(entries) => entries,
            _ => return Err(internal("machine root listing returned the wrong value")),
        };
        let mut directories = entries
            .into_iter()
            .filter_map(|entry| {
                entry.native_path.map(|path| DirectoryEntry {
                    name: entry.name,
                    path,
                })
            })
            .collect::<Vec<_>>();
        directories.sort_by_key(|entry| entry.name.to_lowercase());
        return Ok(DirectoryListing {
            path: String::new(),
            parent: None,
            directories,
            workspace_files: Vec::new(),
            roots: true,
        });
    }
    let requested = requested
        .or_else(|| home.map(str::to_string))
        .ok_or_else(|| bad_request("no home directory"))?;
    let mut client = Client::new(executor, next);
    let path = canonicalize(&requested, &mut client)?;
    let metadata = metadata(&path, &mut client)?;
    if metadata.kind != FileKind::Directory {
        return Err(bad_request(format!("{path} is not a directory")));
    }
    let entries = match client.call(CapabilityRequest::File(FileRequest::List {
        locator: FileLocator {
            root: FileRoot::NativePath,
            path: path.clone(),
        },
    }))? {
        CapabilityValue::FileEntries(entries) => entries,
        _ => return Err(internal("directory listing returned the wrong value")),
    };
    let mut directories = Vec::new();
    let mut workspace_files = Vec::new();
    for entry in entries.into_iter().take(MAX_DIRECTORY_ENTRIES) {
        let Some(native_path) = entry.native_path else {
            continue;
        };
        let item = DirectoryEntry {
            name: entry.name.clone(),
            path: native_path,
        };
        if entry.kind == FileKind::Directory {
            directories.push(item);
        } else if entry.kind == FileKind::File
            && entry.name.to_ascii_lowercase().ends_with(".code-workspace")
        {
            workspace_files.push(item);
        }
    }
    directories.sort_by_key(|entry| entry.name.to_lowercase());
    workspace_files.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(DirectoryListing {
        path,
        parent: metadata.parent_path,
        directories,
        workspace_files,
        roots: false,
    })
}

pub fn mkdir_directory(
    parent: String,
    name: String,
    home: Option<&str>,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<DirectoryListing, ProtocolError> {
    let name = validate_new_entry_name(&name)?;
    if parent.is_empty() {
        return Err(bad_request("cannot create a folder at the machine roots"));
    }
    let mut client = Client::new(executor, next);
    let parent = canonicalize(&parent, &mut client)?;
    let target = match client.call_raw(CapabilityRequest::File(FileRequest::ResolveHostPath {
        base: parent.clone(),
        path: name.to_string(),
    }))? {
        Ok(CapabilityValue::Text(_)) => {
            return Err(ProtocolError {
                code: ErrorCode::Conflict,
                message: format!("{name} already exists"),
            })
        }
        Ok(_) => return Err(internal("host path resolution returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => {
            // ResolveHostPath canonicalizes and therefore cannot name a new
            // leaf. Join only the guest-validated single path component.
            native_join(&parent, name)
        }
        Err(error) => return Err(map_failure(error)),
    };
    match client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
        locator: FileLocator {
            root: FileRoot::NativePath,
            path: target,
        },
    }))? {
        CapabilityValue::Unit => {}
        _ => return Err(internal("directory creation returned the wrong value")),
    }
    directory(Some(parent), home, executor, next)
}

fn validate_new_entry_name(name: &str) -> Result<&str, ProtocolError> {
    let name = name.trim();
    if name.is_empty()
        || name.len() > 255
        || matches!(name, "." | "..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
    {
        return Err(bad_request("folder name is invalid"));
    }
    // Windows-invalid names must be rejected by the Linux-built guest too,
    // because the same artifact runs on every host.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = name.split('.').next().unwrap_or(name);
    if RESERVED.iter().any(|item| stem.eq_ignore_ascii_case(item))
        || name.chars().any(|character| "<>:\"|?*".contains(character))
    {
        return Err(bad_request("folder name is invalid on Windows"));
    }
    Ok(name)
}

fn native_join(parent: &str, name: &str) -> String {
    let separator = if parent.contains('\\') { '\\' } else { '/' };
    format!("{}{separator}{name}", parent.trim_end_matches(['/', '\\']))
}

pub fn workspace(config: &Config, id: &str) -> Result<WorkspaceEntry, ProtocolError> {
    config
        .workspaces
        .iter()
        .find(|workspace| workspace.id == id && !workspace.removed)
        .cloned()
        .ok_or_else(|| not_found(format!("no such workspace: {id}")))
}

fn folder_candidate<E: CapabilityExecutor>(
    root: String,
    name: Option<String>,
    client: &mut Client<'_, E>,
) -> Result<WorkspaceEntry, ProtocolError> {
    let metadata = metadata(&root, client)?;
    let folder_name = metadata
        .file_name
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| root.clone());
    let is_git_repo = child_exists(&root, ".git", client)?;
    Ok(WorkspaceEntry {
        id: String::new(),
        name: match name {
            Some(name) => clean_name(&name)?,
            None => folder_name.clone(),
        },
        root: root.clone(),
        folders: vec![WorkspaceFolderEntry {
            name: folder_name,
            root,
            root_handle: String::new(),
        }],
        workspace_file: None,
        removed: false,
        is_git_repo,
    })
}

fn code_workspace<E: CapabilityExecutor>(
    path: String,
    file_metadata: genet_daemon_logic_api::FileMetadata,
    client: &mut Client<'_, E>,
) -> Result<WorkspaceEntry, ProtocolError> {
    if file_metadata.bytes > MAX_WORKSPACE_FILE_BYTES as u64 {
        return Err(bad_request(format!(
            "workspace file is {} bytes, above the {} byte limit",
            file_metadata.bytes, MAX_WORKSPACE_FILE_BYTES
        )));
    }
    let source = match client.call(CapabilityRequest::File(FileRequest::Read {
        locator: FileLocator {
            root: FileRoot::NativePath,
            path: path.clone(),
        },
        max_bytes: MAX_WORKSPACE_FILE_BYTES,
    }))? {
        CapabilityValue::Bytes(bytes) => String::from_utf8(bytes)
            .map_err(|_| bad_request("workspace file is not valid UTF-8"))?,
        _ => return Err(internal("workspace file read returned the wrong value")),
    };
    let parsed: CodeWorkspace = json5::from_str(&source)
        .map_err(|error| bad_request(format!("parsing workspace file {path}: {error}")))?;
    if parsed.folders.is_empty() || parsed.folders.len() > MAX_WORKSPACE_FOLDERS {
        return Err(bad_request(format!(
            "workspace file must contain 1 through {MAX_WORKSPACE_FOLDERS} folders"
        )));
    }
    let base = file_metadata
        .parent_path
        .ok_or_else(|| bad_request("workspace file has no parent directory"))?;
    let mut seen = HashSet::new();
    let mut folders = Vec::with_capacity(parsed.folders.len());
    for (index, folder) in parsed.folders.into_iter().enumerate() {
        if folder.uri.is_some() {
            return Err(bad_request(format!(
                "workspace folder {} uses a URI; this version supports local path entries only",
                index + 1
            )));
        }
        let raw = folder
            .path
            .filter(|value| !value.is_empty())
            .ok_or_else(|| bad_request(format!("workspace folder {} has no path", index + 1)))?;
        let root = match client.call(CapabilityRequest::File(FileRequest::ResolveHostPath {
            base: base.clone(),
            path: raw,
        }))? {
            CapabilityValue::Text(path) => path,
            _ => return Err(internal("host path resolution returned the wrong value")),
        };
        let root_metadata = metadata(&root, client)?;
        if root_metadata.kind != FileKind::Directory {
            return Err(bad_request(format!(
                "workspace folder {} is not a directory: {root}",
                index + 1
            )));
        }
        if !seen.insert(root.clone()) {
            return Err(bad_request(
                "workspace file contains the same folder more than once",
            ));
        }
        let fallback = root_metadata
            .file_name
            .unwrap_or_else(|| native_leaf(&root));
        folders.push(WorkspaceFolderEntry {
            name: match folder.name {
                Some(name) => clean_name(&name)?,
                None => fallback,
            },
            root,
            root_handle: String::new(),
        });
    }
    let root = folders[0].root.clone();
    let name = file_metadata
        .file_name
        .as_deref()
        .and_then(|name| name.strip_suffix(".code-workspace"))
        .filter(|name| !name.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| folders[0].name.clone());
    let is_git_repo = child_exists(&root, ".git", client)?;
    Ok(WorkspaceEntry {
        id: String::new(),
        name,
        root,
        folders,
        workspace_file: Some(path),
        removed: false,
        is_git_repo,
    })
}

fn attach_entry<E: CapabilityExecutor>(
    config: &mut Config,
    mut entry: WorkspaceEntry,
    client: &mut Client<'_, E>,
) -> Result<(), ProtocolError> {
    entry.id = random_id_with_client("w_", client)?;
    attach_roots(config, &mut entry, client)?;
    config.workspaces.push(entry);
    config.workspace_catalog_revision = config.workspace_catalog_revision.saturating_add(1);
    Ok(())
}

fn attach_roots<E: CapabilityExecutor>(
    config: &mut Config,
    entry: &mut WorkspaceEntry,
    client: &mut Client<'_, E>,
) -> Result<(), ProtocolError> {
    for folder in &mut entry.folders {
        let handle = if let Some(root) = config
            .workspace_roots
            .iter()
            .find(|root| root.root == folder.root)
        {
            root.handle.clone()
        } else {
            let handle = random_id_with_client("r_", client)?;
            config.workspace_roots.push(WorkspaceRootEntry {
                handle: handle.clone(),
                root: folder.root.clone(),
            });
            handle
        };
        match client.call(CapabilityRequest::File(
            FileRequest::RegisterWorkspaceRoot {
                handle: handle.clone(),
                native_path: folder.root.clone(),
            },
        ))? {
            CapabilityValue::Text(_) => folder.root_handle = handle,
            _ => {
                return Err(internal(
                    "workspace root registration returned the wrong value",
                ))
            }
        }
    }
    entry.root = entry
        .folders
        .first()
        .ok_or_else(|| bad_request("workspace has no folders"))?
        .root
        .clone();
    Ok(())
}

fn canonicalize<E: CapabilityExecutor>(
    path: &str,
    client: &mut Client<'_, E>,
) -> Result<String, ProtocolError> {
    match client.call(CapabilityRequest::File(FileRequest::CanonicalizeHostPath {
        path: path.to_string(),
    }))? {
        CapabilityValue::Text(path) => Ok(path),
        _ => Err(internal(
            "host path canonicalization returned the wrong value",
        )),
    }
}

fn metadata<E: CapabilityExecutor>(
    path: &str,
    client: &mut Client<'_, E>,
) -> Result<genet_daemon_logic_api::FileMetadata, ProtocolError> {
    match client.call(CapabilityRequest::File(FileRequest::Metadata {
        locator: FileLocator {
            root: FileRoot::NativePath,
            path: path.to_string(),
        },
    }))? {
        CapabilityValue::FileMetadata(metadata) => Ok(metadata),
        _ => Err(internal("file metadata returned the wrong value")),
    }
}

fn child_exists<E: CapabilityExecutor>(
    base: &str,
    child: &str,
    client: &mut Client<'_, E>,
) -> Result<bool, ProtocolError> {
    let path = match client.call_raw(CapabilityRequest::File(FileRequest::ResolveHostPath {
        base: base.to_string(),
        path: child.to_string(),
    }))? {
        Ok(CapabilityValue::Text(path)) => path,
        Ok(_) => return Err(internal("host path resolution returned the wrong value")),
        Err(error) if error.kind == CapabilityFailureKind::NotFound => return Ok(false),
        Err(error) => return Err(map_failure(error)),
    };
    Ok(metadata(&path, client).is_ok())
}

fn random_id(
    prefix: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<String, ProtocolError> {
    random_id_with_client(prefix, &mut Client::new(executor, next))
}

fn random_id_with_client<E: CapabilityExecutor>(
    prefix: &str,
    client: &mut Client<'_, E>,
) -> Result<String, ProtocolError> {
    let bytes = match client.call(CapabilityRequest::Random { bytes: 16 })? {
        CapabilityValue::Bytes(bytes) if bytes.len() == 16 => bytes,
        _ => return Err(internal("random capability returned the wrong value")),
    };
    Ok(format!(
        "{prefix}{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
}

fn clean_name(value: &str) -> Result<String, ProtocolError> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().any(|character| {
            character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
    {
        return Err(bad_request(
            "workspace name is empty or contains control characters",
        ));
    }
    Ok(value.chars().take(80).collect())
}

fn describe(entry: &WorkspaceEntry) -> WorkspaceInfo {
    WorkspaceInfo {
        id: entry.id.clone(),
        name: entry.name.clone(),
        root: entry.root.clone(),
        is_git_repo: entry.is_git_repo,
        folders: entry
            .folders
            .iter()
            .map(|folder| WorkspaceFolderInfo {
                name: folder.name.clone(),
                root: folder.root.clone(),
                root_handle: folder.root_handle.clone(),
            })
            .collect(),
        workspace_file: entry.workspace_file.clone(),
    }
}

fn same_project_source(left: &WorkspaceEntry, right: &WorkspaceEntry) -> bool {
    left.root == right.root
        && match (&left.workspace_file, &right.workspace_file) {
            (None, None) => true,
            (Some(left), Some(right)) => left == right,
            _ => false,
        }
}

fn native_leaf(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| !name.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn map_failure(error: genet_daemon_logic_api::CapabilityFailure) -> ProtocolError {
    ProtocolError {
        code: match error.kind {
            CapabilityFailureKind::Invalid => ErrorCode::BadRequest,
            CapabilityFailureKind::Denied => ErrorCode::Forbidden,
            CapabilityFailureKind::NotFound => ErrorCode::NotFound,
            CapabilityFailureKind::Conflict => ErrorCode::Conflict,
            CapabilityFailureKind::Unavailable
            | CapabilityFailureKind::TooLarge
            | CapabilityFailureKind::Internal => ErrorCode::Internal,
        },
        message: error.message,
    }
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn not_found(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::NotFound,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}
