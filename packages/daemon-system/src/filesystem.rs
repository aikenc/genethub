use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use genet_daemon_logic_api::{
    CapabilityFailure, CapabilityFailureKind, CapabilityValue, FileEntry, FileKind, FileLocator,
    FileMetadata, FileRequest, FileRoot, MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::sync::RwLock;

use crate::failure;

#[derive(Debug)]
pub struct SystemRoots {
    private: PathBuf,
    logs: PathBuf,
    workspaces: HashMap<String, PathBuf>,
}

impl SystemRoots {
    pub fn new(private: PathBuf, logs: PathBuf) -> anyhow::Result<Self> {
        fs::create_dir_all(&private)?;
        fs::create_dir_all(&logs)?;
        tighten_directory(&private)?;
        tighten_directory(&logs)?;
        Ok(Self {
            private: private.canonicalize()?,
            logs: logs.canonicalize()?,
            workspaces: HashMap::new(),
        })
    }
}

pub async fn secure_read(
    roots: &Arc<RwLock<SystemRoots>>,
    key: &str,
    max_bytes: u32,
) -> Result<CapabilityValue, CapabilityFailure> {
    execute(
        roots,
        FileRequest::Read {
            locator: FileLocator {
                root: FileRoot::Private,
                path: key.to_string(),
            },
            max_bytes,
        },
    )
    .await
}

pub async fn secure_write(
    roots: &Arc<RwLock<SystemRoots>>,
    key: &str,
    bytes: &[u8],
) -> Result<CapabilityValue, CapabilityFailure> {
    execute(
        roots,
        FileRequest::WriteAtomic {
            locator: FileLocator {
                root: FileRoot::Private,
                path: key.to_string(),
            },
            bytes: bytes.to_vec(),
        },
    )
    .await
}

pub async fn secure_remove(
    roots: &Arc<RwLock<SystemRoots>>,
    key: &str,
) -> Result<CapabilityValue, CapabilityFailure> {
    execute(
        roots,
        FileRequest::RemoveFile {
            locator: FileLocator {
                root: FileRoot::Private,
                path: key.to_string(),
            },
        },
    )
    .await
}

pub async fn execute(
    roots: &Arc<RwLock<SystemRoots>>,
    request: FileRequest,
) -> Result<CapabilityValue, CapabilityFailure> {
    match request {
        FileRequest::RegisterWorkspaceRoot {
            handle,
            native_path,
        } => {
            validate_handle(&handle)?;
            let path = canonical_directory(Path::new(&native_path))?;
            let mut held = roots.write().await;
            if let Some(existing) = held.workspaces.get(&handle) {
                if existing != &path {
                    return Err(failure(
                        CapabilityFailureKind::Conflict,
                        format!("workspace root handle {handle} is already registered"),
                    ));
                }
            } else {
                held.workspaces.insert(handle, path.clone());
            }
            Ok(CapabilityValue::Text(path.display().to_string()))
        }
        FileRequest::UnregisterWorkspaceRoot { handle } => {
            roots.write().await.workspaces.remove(&handle);
            Ok(CapabilityValue::Unit)
        }
        FileRequest::Read { locator, max_bytes } => {
            let limit = checked_limit(max_bytes)?;
            let path = resolve(roots, &locator, false).await?;
            let metadata = fs::symlink_metadata(&path).map_err(io_failure)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    format!("not a regular file: {}", path.display()),
                ));
            }
            if metadata.len() > limit as u64 {
                return Err(failure(
                    CapabilityFailureKind::TooLarge,
                    format!("file exceeds {limit} bytes"),
                ));
            }
            let file = fs::File::open(&path).map_err(io_failure)?;
            let mut bytes = Vec::with_capacity(metadata.len() as usize);
            file.take(limit as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(io_failure)?;
            if bytes.len() > limit {
                return Err(failure(
                    CapabilityFailureKind::TooLarge,
                    format!("file exceeds {limit} bytes"),
                ));
            }
            Ok(CapabilityValue::Bytes(bytes))
        }
        FileRequest::ReadTail { locator, max_bytes } => {
            let limit = checked_limit(max_bytes)?;
            let path = resolve(roots, &locator, false).await?;
            let metadata = fs::symlink_metadata(&path).map_err(io_failure)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    format!("not a regular file: {}", path.display()),
                ));
            }
            let mut file = fs::File::open(&path).map_err(io_failure)?;
            let offset = metadata.len().saturating_sub(limit as u64);
            use std::io::{Seek, SeekFrom};
            file.seek(SeekFrom::Start(offset)).map_err(io_failure)?;
            let mut bytes = Vec::with_capacity((metadata.len() - offset) as usize);
            file.take(limit as u64)
                .read_to_end(&mut bytes)
                .map_err(io_failure)?;
            Ok(CapabilityValue::Bytes(bytes))
        }
        FileRequest::WriteAtomic { locator, bytes } => {
            checked_bytes(&bytes)?;
            let path = resolve(roots, &locator, true).await?;
            let parent = path.parent().ok_or_else(|| {
                failure(
                    CapabilityFailureKind::Invalid,
                    "file has no parent directory",
                )
            })?;
            fs::create_dir_all(parent).map_err(io_failure)?;
            reject_symlink_chain(parent)?;
            let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(io_failure)?;
            temporary.write_all(&bytes).map_err(io_failure)?;
            temporary.as_file().sync_all().map_err(io_failure)?;
            tighten_file(temporary.path()).map_err(io_failure)?;
            temporary
                .persist(&path)
                .map_err(|error| io_failure(error.error))?;
            tighten_file(&path).map_err(io_failure)?;
            Ok(CapabilityValue::Unit)
        }
        FileRequest::Append { locator, bytes } => {
            checked_bytes(&bytes)?;
            let path = resolve(roots, &locator, true).await?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(io_failure)?;
                reject_symlink_chain(parent)?;
            }
            let mut options = fs::OpenOptions::new();
            options.create(true).append(true);
            let mut file = options.open(&path).map_err(io_failure)?;
            file.write_all(&bytes).map_err(io_failure)?;
            file.sync_data().map_err(io_failure)?;
            tighten_file(&path).map_err(io_failure)?;
            Ok(CapabilityValue::Unit)
        }
        FileRequest::List { locator } => {
            let include_native_path = matches!(&locator.root, FileRoot::NativePath);
            let path = resolve(roots, &locator, false).await?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(&path).map_err(io_failure)? {
                let entry = entry.map_err(io_failure)?;
                let metadata = entry.path().symlink_metadata().map_err(io_failure)?;
                entries.push(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    kind: file_kind(&metadata),
                    bytes: metadata.len(),
                    modified_at_millis: modified_at(&metadata),
                    native_path: include_native_path.then(|| entry.path().display().to_string()),
                });
                if entries.len() > 100_000 {
                    return Err(failure(
                        CapabilityFailureKind::TooLarge,
                        "directory contains more than 100000 entries",
                    ));
                }
            }
            entries.sort_by(|left, right| left.name.cmp(&right.name));
            Ok(CapabilityValue::FileEntries(entries))
        }
        FileRequest::Metadata { locator } => {
            let path = resolve(roots, &locator, false).await?;
            let metadata = fs::symlink_metadata(&path).map_err(io_failure)?;
            Ok(CapabilityValue::FileMetadata(FileMetadata {
                kind: file_kind(&metadata),
                bytes: metadata.len(),
                modified_at_millis: modified_at(&metadata),
                canonical_path: path
                    .canonicalize()
                    .ok()
                    .map(|path| path.display().to_string()),
                parent_path: path.parent().map(|path| path.display().to_string()),
                file_name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string()),
                extension: path
                    .extension()
                    .map(|extension| extension.to_string_lossy().to_string()),
            }))
        }
        FileRequest::CreateDirAll { locator } => {
            let path = resolve(roots, &locator, true).await?;
            fs::create_dir_all(&path).map_err(io_failure)?;
            reject_symlink_chain(&path)?;
            Ok(CapabilityValue::Unit)
        }
        FileRequest::RemoveFile { locator } => {
            let path = resolve(roots, &locator, false).await?;
            match fs::remove_file(&path) {
                Ok(()) => Ok(CapabilityValue::Unit),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(CapabilityValue::Unit)
                }
                Err(error) => Err(io_failure(error)),
            }
        }
        FileRequest::RemoveDirAll { locator } => {
            let path = resolve(roots, &locator, false).await?;
            match fs::remove_dir_all(&path) {
                Ok(()) => Ok(CapabilityValue::Unit),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    Ok(CapabilityValue::Unit)
                }
                Err(error) => Err(io_failure(error)),
            }
        }
        FileRequest::Rename { from, to } => {
            if std::mem::discriminant(&from.root) != std::mem::discriminant(&to.root) {
                return Err(failure(
                    CapabilityFailureKind::Denied,
                    "rename cannot cross capability roots",
                ));
            }
            let from = resolve(roots, &from, false).await?;
            let to = resolve(roots, &to, true).await?;
            if let Some(parent) = to.parent() {
                fs::create_dir_all(parent).map_err(io_failure)?;
            }
            fs::rename(from, to).map_err(io_failure)?;
            Ok(CapabilityValue::Unit)
        }
        FileRequest::CanonicalizeHostPath { path } => {
            let path = PathBuf::from(path).canonicalize().map_err(io_failure)?;
            Ok(CapabilityValue::Text(path.display().to_string()))
        }
        FileRequest::ResolveHostPath { base, path } => {
            if path.contains('\0') {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "host path contains NUL",
                ));
            }
            let requested = PathBuf::from(&path);
            let requested = if requested.is_absolute() {
                requested
            } else {
                PathBuf::from(base).join(requested)
            };
            let canonical = requested.canonicalize().map_err(io_failure)?;
            Ok(CapabilityValue::Text(canonical.display().to_string()))
        }
    }
}

async fn resolve(
    roots: &Arc<RwLock<SystemRoots>>,
    locator: &FileLocator,
    allow_missing_leaf: bool,
) -> Result<PathBuf, CapabilityFailure> {
    if matches!(locator.root, FileRoot::NativePath) {
        let path = PathBuf::from(&locator.path);
        if !path.is_absolute() {
            return Err(failure(
                CapabilityFailureKind::Invalid,
                "native path must be absolute",
            ));
        }
        if allow_missing_leaf {
            if let Some(parent) = path.parent() {
                reject_symlink_chain(parent)?;
            }
        } else {
            reject_symlink_chain(&path)?;
        }
        return Ok(path);
    }

    let relative = validate_relative(&locator.path)?;
    let held = roots.read().await;
    let root = match &locator.root {
        FileRoot::Private => &held.private,
        FileRoot::Logs => &held.logs,
        FileRoot::Workspace { handle } => held.workspaces.get(handle).ok_or_else(|| {
            failure(
                CapabilityFailureKind::Denied,
                format!("workspace root {handle} is not registered"),
            )
        })?,
        FileRoot::NativePath => unreachable!(),
    };
    let path = root.join(relative);
    if allow_missing_leaf {
        let parent = path.parent().unwrap_or(root);
        ensure_beneath(root, parent)?;
    } else {
        ensure_beneath(root, &path)?;
    }
    Ok(path)
}

pub(crate) async fn resolve_locator(
    roots: &Arc<RwLock<SystemRoots>>,
    locator: &FileLocator,
) -> Result<PathBuf, CapabilityFailure> {
    resolve(roots, locator, false).await
}

fn validate_relative(value: &str) -> Result<PathBuf, CapabilityFailure> {
    let path = Path::new(value);
    if path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(failure(
            CapabilityFailureKind::Denied,
            format!("path escapes its capability root: {value}"),
        ));
    }
    Ok(path.to_path_buf())
}

fn ensure_beneath(root: &Path, path: &Path) -> Result<(), CapabilityFailure> {
    reject_symlink_chain(path)?;
    let existing = nearest_existing(path)?;
    let canonical = existing.canonicalize().map_err(io_failure)?;
    if !canonical.starts_with(root) {
        return Err(failure(
            CapabilityFailureKind::Denied,
            format!("path escapes capability root: {}", path.display()),
        ));
    }
    Ok(())
}

fn nearest_existing(path: &Path) -> Result<&Path, CapabilityFailure> {
    let mut candidate = Some(path);
    while let Some(value) = candidate {
        if value.exists() {
            return Ok(value);
        }
        candidate = value.parent();
    }
    Err(failure(
        CapabilityFailureKind::NotFound,
        format!("no existing ancestor for {}", path.display()),
    ))
}

fn reject_symlink_chain(path: &Path) -> Result<(), CapabilityFailure> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(failure(
                    CapabilityFailureKind::Denied,
                    format!(
                        "symbolic link is not a capability boundary: {}",
                        current.display()
                    ),
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(io_failure(error)),
        }
    }
    Ok(())
}

fn canonical_directory(path: &Path) -> Result<PathBuf, CapabilityFailure> {
    let canonical = path.canonicalize().map_err(io_failure)?;
    let metadata = fs::symlink_metadata(&canonical).map_err(io_failure)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            format!("workspace root is not a real directory: {}", path.display()),
        ));
    }
    Ok(canonical)
}

fn validate_handle(handle: &str) -> Result<(), CapabilityFailure> {
    if handle.len() < 3
        || handle.len() > 128
        || !handle
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(failure(
            CapabilityFailureKind::Invalid,
            "workspace root handle is malformed",
        ));
    }
    Ok(())
}

fn checked_limit(value: u32) -> Result<usize, CapabilityFailure> {
    let value = value as usize;
    if value == 0 || value > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "file limit is empty or exceeds the capability chunk limit",
        ));
    }
    Ok(value)
}

fn checked_bytes(bytes: &[u8]) -> Result<(), CapabilityFailure> {
    if bytes.len() > MAX_CAPABILITY_CHUNK_BYTES {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "file write exceeds the capability chunk limit",
        ));
    }
    Ok(())
}

fn file_kind(metadata: &fs::Metadata) -> FileKind {
    let kind = metadata.file_type();
    if kind.is_symlink() {
        FileKind::Symlink
    } else if kind.is_file() {
        FileKind::File
    } else if kind.is_dir() {
        FileKind::Directory
    } else {
        FileKind::Other
    }
}

fn modified_at(metadata: &fs::Metadata) -> Option<i64> {
    let duration = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_millis()).ok()
}

fn io_failure(error: std::io::Error) -> CapabilityFailure {
    let kind = match error.kind() {
        std::io::ErrorKind::NotFound => CapabilityFailureKind::NotFound,
        std::io::ErrorKind::PermissionDenied => CapabilityFailureKind::Denied,
        std::io::ErrorKind::AlreadyExists => CapabilityFailureKind::Conflict,
        std::io::ErrorKind::InvalidInput | std::io::ErrorKind::InvalidData => {
            CapabilityFailureKind::Invalid
        }
        _ => CapabilityFailureKind::Internal,
    };
    failure(kind, error.to_string())
}

#[cfg(unix)]
fn tighten_directory(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn tighten_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn tighten_file(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn tighten_file(_path: &Path) -> std::io::Result<()> {
    Ok(())
}
