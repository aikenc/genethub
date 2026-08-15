use genehub_proto::{ErrorCode, FileNode, ProtocolError};
use genet_daemon_logic_api::{
    CapabilityRequest, CapabilityValue, FileKind, FileLocator, FileRequest, FileRoot,
};

use crate::capability::Client;
use crate::config::{WorkspaceEntry, WorkspaceFolderEntry};
use crate::CapabilityExecutor;

const MAX_ENTRIES_PER_DIR: usize = 2_000;
const MAX_TREE_NODES: usize = 10_000;

pub fn tree(
    workspace: &WorkspaceEntry,
    requested: Option<&str>,
    depth: u32,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<FileNode, ProtocolError> {
    let mut client = Client::new(executor, next);
    let mut remaining = MAX_TREE_NODES;
    if workspace.workspace_file.is_some() && requested.is_none() {
        let children = if depth == 0 {
            None
        } else {
            Some(
                workspace
                    .folders
                    .iter()
                    .map(|folder| {
                        tree_in(
                            folder,
                            "",
                            depth.saturating_sub(1),
                            &mut remaining,
                            &mut client,
                        )
                    })
                    .collect::<Result<Vec<_>, _>>()?,
            )
        };
        return Ok(FileNode {
            name: workspace.name.clone(),
            path: String::new(),
            is_dir: true,
            size: None,
            children,
        });
    }

    let (folder, relative) = match requested {
        None => (
            workspace
                .folders
                .first()
                .ok_or_else(|| bad_request("workspace has no folders"))?,
            "",
        ),
        Some(path) => resolve(workspace, path)?,
    };
    tree_in(folder, relative, depth, &mut remaining, &mut client)
}

pub fn write(
    workspace: &WorkspaceEntry,
    path: &str,
    content: String,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let (folder, relative) = resolve(workspace, path)?;
    if relative.is_empty() {
        return Err(bad_request("file path names a workspace root"));
    }
    let mut client = Client::new(executor, next);
    match client.call(CapabilityRequest::File(FileRequest::WriteAtomic {
        locator: locator(folder, relative),
        bytes: content.into_bytes(),
    }))? {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal("file write returned the wrong value")),
    }
}

pub fn mkdir(
    workspace: &WorkspaceEntry,
    path: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let (folder, relative) = resolve_non_root(workspace, path)?;
    let mut client = Client::new(executor, next);
    if exists(&locator(folder, relative), &mut client)? {
        return Err(conflict(format!("{path} already exists")));
    }
    unit(
        client.call(CapabilityRequest::File(FileRequest::CreateDirAll {
            locator: locator(folder, relative),
        }))?,
        "directory creation",
    )
}

pub fn copy(
    workspace: &WorkspaceEntry,
    from: &str,
    to: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let (source_folder, source) = resolve_non_root(workspace, from)?;
    let (target_folder, target) = resolve_non_root(workspace, to)?;
    validate_transfer(source_folder, source, target_folder, target)?;
    let mut client = Client::new(executor, next);
    unit(
        client.call(CapabilityRequest::File(FileRequest::Copy {
            from: locator(source_folder, source),
            to: locator(target_folder, target),
        }))?,
        "file copy",
    )
}

pub fn move_path(
    workspace: &WorkspaceEntry,
    from: &str,
    to: &str,
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    let (source_folder, source) = resolve_non_root(workspace, from)?;
    let (target_folder, target) = resolve_non_root(workspace, to)?;
    validate_transfer(source_folder, source, target_folder, target)?;
    let mut client = Client::new(executor, next);
    unit(
        client.call(CapabilityRequest::File(FileRequest::Rename {
            from: locator(source_folder, source),
            to: locator(target_folder, target),
        }))?,
        "file move",
    )
}

pub fn delete(
    workspace: &WorkspaceEntry,
    paths: &[String],
    executor: &mut impl CapabilityExecutor,
    next: &mut u64,
) -> Result<(), ProtocolError> {
    if paths.is_empty() || paths.len() > 256 {
        return Err(bad_request("delete requires 1 through 256 paths"));
    }
    let mut client = Client::new(executor, next);
    for path in paths {
        let (folder, relative) = resolve_non_root(workspace, path)?;
        let target = locator(folder, relative);
        let metadata = match client.call(CapabilityRequest::File(FileRequest::Metadata {
            locator: target.clone(),
        }))? {
            CapabilityValue::FileMetadata(metadata) => metadata,
            _ => return Err(internal("file delete metadata returned the wrong value")),
        };
        let request = if metadata.kind == FileKind::Directory {
            FileRequest::RemoveDirAll { locator: target }
        } else {
            FileRequest::RemoveFile { locator: target }
        };
        unit(
            client.call(CapabilityRequest::File(request))?,
            "file delete",
        )?;
    }
    Ok(())
}

fn resolve_non_root<'a>(
    workspace: &'a WorkspaceEntry,
    path: &'a str,
) -> Result<(&'a WorkspaceFolderEntry, &'a str), ProtocolError> {
    let (folder, relative) = resolve(workspace, path)?;
    if relative.is_empty() {
        return Err(forbidden("operation cannot target a workspace root"));
    }
    Ok((folder, relative))
}

fn validate_transfer(
    source_folder: &WorkspaceFolderEntry,
    source: &str,
    target_folder: &WorkspaceFolderEntry,
    target: &str,
) -> Result<(), ProtocolError> {
    if source_folder.root_handle != target_folder.root_handle {
        return Err(bad_request(
            "transfer must stay inside the same workspace root",
        ));
    }
    if target == source
        || target
            .strip_prefix(source)
            .is_some_and(|tail| tail.starts_with('/'))
    {
        return Err(bad_request("cannot place a path inside itself"));
    }
    Ok(())
}

fn exists<E: CapabilityExecutor>(
    locator: &FileLocator,
    client: &mut Client<'_, E>,
) -> Result<bool, ProtocolError> {
    match client.call_raw(CapabilityRequest::File(FileRequest::Metadata {
        locator: locator.clone(),
    }))? {
        Ok(CapabilityValue::FileMetadata(_)) => Ok(true),
        Ok(_) => Err(internal("file metadata returned the wrong value")),
        Err(error) if error.kind == genet_daemon_logic_api::CapabilityFailureKind::NotFound => {
            Ok(false)
        }
        Err(error) => Err(ProtocolError {
            code: ErrorCode::Internal,
            message: error.message,
        }),
    }
}

fn unit(value: CapabilityValue, operation: &str) -> Result<(), ProtocolError> {
    match value {
        CapabilityValue::Unit => Ok(()),
        _ => Err(internal(format!("{operation} returned the wrong value"))),
    }
}

fn tree_in<E: CapabilityExecutor>(
    folder: &WorkspaceFolderEntry,
    relative: &str,
    depth: u32,
    remaining: &mut usize,
    client: &mut Client<'_, E>,
) -> Result<FileNode, ProtocolError> {
    if *remaining == 0 {
        return Err(bad_request("file tree exceeded the node safety limit"));
    }
    *remaining -= 1;
    let metadata = match client.call(CapabilityRequest::File(FileRequest::Metadata {
        locator: locator(folder, relative),
    }))? {
        CapabilityValue::FileMetadata(metadata) => metadata,
        _ => return Err(internal("file metadata returned the wrong value")),
    };
    let name = if relative.is_empty() {
        folder.name.clone()
    } else {
        relative.rsplit('/').next().unwrap_or(relative).to_string()
    };
    let display_path = if relative.is_empty() {
        folder.root_handle.clone()
    } else {
        format!("{}/{}", folder.root_handle, relative)
    };
    if metadata.kind != FileKind::Directory {
        return Ok(FileNode {
            name,
            path: display_path,
            is_dir: false,
            size: Some(metadata.bytes),
            children: None,
        });
    }
    let children = if depth == 0 {
        None
    } else {
        let entries = match client.call(CapabilityRequest::File(FileRequest::List {
            locator: locator(folder, relative),
        }))? {
            CapabilityValue::FileEntries(entries) => entries,
            _ => return Err(internal("file listing returned the wrong value")),
        };
        let mut children = Vec::new();
        for entry in entries.into_iter().take(MAX_ENTRIES_PER_DIR) {
            if *remaining == 0 {
                break;
            }
            if is_noise(&entry.name) || matches!(entry.kind, FileKind::Symlink | FileKind::Other) {
                continue;
            }
            let child_relative = if relative.is_empty() {
                entry.name
            } else {
                format!("{relative}/{}", entry.name)
            };
            match tree_in(
                folder,
                &child_relative,
                depth.saturating_sub(1),
                remaining,
                client,
            ) {
                Ok(node) => children.push(node),
                Err(error) if matches!(error.code, ErrorCode::NotFound) => {}
                Err(error) => return Err(error),
            }
        }
        children.sort_by(|left, right| {
            right
                .is_dir
                .cmp(&left.is_dir)
                .then(left.name.cmp(&right.name))
        });
        Some(children)
    };
    Ok(FileNode {
        name,
        path: display_path,
        is_dir: true,
        size: None,
        children,
    })
}

pub fn resolve<'a>(
    workspace: &'a WorkspaceEntry,
    path: &'a str,
) -> Result<(&'a WorkspaceFolderEntry, &'a str), ProtocolError> {
    if path.is_empty()
        || path == "."
        || path.contains('\0')
        || path.contains('\\')
        || path.starts_with('/')
        || path.split('/').any(|part| matches!(part, "." | ".."))
    {
        return Err(forbidden("workspace path is not canonical"));
    }
    let (handle, relative) = path
        .split_once('/')
        .map_or((path, ""), |(handle, relative)| (handle, relative));
    let folder = workspace
        .folders
        .iter()
        .find(|folder| folder.root_handle == handle)
        .ok_or_else(|| forbidden("root handle is not a member of this workspace"))?;
    Ok((folder, relative))
}

fn locator(folder: &WorkspaceFolderEntry, path: &str) -> FileLocator {
    FileLocator {
        root: FileRoot::Workspace {
            handle: folder.root_handle.clone(),
        },
        path: path.to_string(),
    }
}

pub fn resolve_locator(
    workspace: &WorkspaceEntry,
    path: &str,
) -> Result<FileLocator, ProtocolError> {
    let (folder, relative) = resolve(workspace, path)?;
    if relative.is_empty() {
        return Err(forbidden("preview path names a workspace root"));
    }
    Ok(locator(folder, relative))
}

fn is_noise(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".venv" | "__pycache__" | ".DS_Store"
    )
}

fn bad_request(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::BadRequest,
        message: message.into(),
    }
}

fn forbidden(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Forbidden,
        message: message.into(),
    }
}

fn internal(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Internal,
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> ProtocolError {
    ProtocolError {
        code: ErrorCode::Conflict,
        message: message.into(),
    }
}
