use std::collections::HashMap;
use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use genet_daemon_logic_api::{
    CapabilityFailure, CapabilityFailureKind, CapabilityValue, FileEntry, FileKind, FileLocator,
    FileMetadata, FileRequest, FileRoot, MAX_CAPABILITY_CHUNK_BYTES,
};
use tokio::sync::RwLock;

use crate::failure;

/// Kernel file locks owned by native code and addressed by opaque ids.
///
/// The guest stores only an id in its snapshot, so a hot replacement keeps
/// the same lock alive without transferring an OS handle through Wasm.
pub struct FileLocks {
    next_id: AtomicU64,
    held: Mutex<HashMap<u64, File>>,
}

impl Default for FileLocks {
    fn default() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            held: Mutex::new(HashMap::new()),
        }
    }
}

impl FileLocks {
    pub async fn execute(
        &self,
        roots: &Arc<RwLock<SystemRoots>>,
        request: FileRequest,
    ) -> Result<CapabilityValue, CapabilityFailure> {
        match request {
            FileRequest::Lock { locator, exclusive } => {
                let path = resolve(roots, &locator, true).await?;
                if let Some(parent) = path.parent() {
                    fs::create_dir_all(parent).map_err(io_failure)?;
                    tighten_directory(parent).map_err(io_failure)?;
                }
                let file = OpenOptions::new()
                    .create(true)
                    .read(true)
                    .write(true)
                    .truncate(false)
                    .open(&path)
                    .map_err(io_failure)?;
                tighten_file(&path).map_err(io_failure)?;
                let lock = if exclusive {
                    fs2::FileExt::try_lock_exclusive(&file)
                } else {
                    fs2::FileExt::try_lock_shared(&file)
                };
                lock.map_err(|error| {
                    failure(
                        if error.kind() == std::io::ErrorKind::WouldBlock {
                            CapabilityFailureKind::Conflict
                        } else {
                            CapabilityFailureKind::Unavailable
                        },
                        format!("locking {}: {error}", path.display()),
                    )
                })?;
                let resource_id = self.next_id.fetch_add(1, Ordering::Relaxed);
                self.held
                    .lock()
                    .map_err(|_| {
                        failure(
                            CapabilityFailureKind::Unavailable,
                            "file lock table is poisoned",
                        )
                    })?
                    .insert(resource_id, file);
                Ok(CapabilityValue::FileLocked { resource_id })
            }
            FileRequest::Unlock { resource_id } => {
                let file = self
                    .held
                    .lock()
                    .map_err(|_| {
                        failure(
                            CapabilityFailureKind::Unavailable,
                            "file lock table is poisoned",
                        )
                    })?
                    .remove(&resource_id)
                    .ok_or_else(|| {
                        failure(
                            CapabilityFailureKind::NotFound,
                            format!("unknown file lock resource {resource_id}"),
                        )
                    })?;
                fs2::FileExt::unlock(&file).map_err(io_failure)?;
                Ok(CapabilityValue::Unit)
            }
            _ => Err(failure(
                CapabilityFailureKind::Invalid,
                "non-lock request reached the file lock table",
            )),
        }
    }

    pub fn close_all(&self) {
        if let Ok(mut held) = self.held.lock() {
            for (_, file) in held.drain() {
                let _ = fs2::FileExt::unlock(&file);
            }
        }
    }
}

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
        FileRequest::MachineRoots => Ok(CapabilityValue::FileEntries(machine_roots())),
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
        FileRequest::ReadRange {
            locator,
            offset,
            length,
        } => {
            let limit = checked_limit(length)?;
            let path = resolve(roots, &locator, false).await?;
            let metadata = fs::symlink_metadata(&path).map_err(io_failure)?;
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    format!("not a regular file: {}", path.display()),
                ));
            }
            if offset > metadata.len() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "file range starts after end of file",
                ));
            }
            use std::io::{Seek, SeekFrom};
            let mut file = fs::File::open(&path).map_err(io_failure)?;
            file.seek(SeekFrom::Start(offset)).map_err(io_failure)?;
            let available = metadata.len().saturating_sub(offset).min(limit as u64);
            let mut bytes = Vec::with_capacity(available as usize);
            file.take(available)
                .read_to_end(&mut bytes)
                .map_err(io_failure)?;
            Ok(CapabilityValue::Bytes(bytes))
        }
        FileRequest::Lock { .. } | FileRequest::Unlock { .. } => Err(failure(
            CapabilityFailureKind::Invalid,
            "file locks are handled by the native resource table",
        )),
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
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(failure(
                        CapabilityFailureKind::Denied,
                        format!("append target is not a plain file: {}", path.display()),
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(io_failure(error)),
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
            if from.root != to.root {
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
        FileRequest::Copy { from, to } => {
            if from.root != to.root {
                return Err(failure(
                    CapabilityFailureKind::Denied,
                    "copy cannot cross capability roots",
                ));
            }
            let from = resolve(roots, &from, false).await?;
            let to = resolve(roots, &to, true).await?;
            if to.exists() {
                return Err(failure(
                    CapabilityFailureKind::Conflict,
                    format!("{} already exists", to.display()),
                ));
            }
            if to == from || to.starts_with(&from) {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "cannot place a path inside itself",
                ));
            }
            copy_recursive(&from, &to, 0)?;
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
        FileRequest::ResolveWorkspacePath {
            roots: requested_roots,
            default_handle,
            path,
        } => {
            if requested_roots.is_empty() || requested_roots.len() > 64 {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "workspace path resolution requires 1 through 64 roots",
                ));
            }
            let mut canonical_roots = Vec::with_capacity(requested_roots.len());
            for root in requested_roots {
                validate_handle(&root.handle)?;
                let canonical = canonical_directory(Path::new(&root.native_path))?;
                let registered = roots
                    .read()
                    .await
                    .workspaces
                    .get(&root.handle)
                    .cloned()
                    .ok_or_else(|| {
                        failure(
                            CapabilityFailureKind::Denied,
                            format!("workspace root {} is not registered", root.handle),
                        )
                    })?;
                if registered != canonical {
                    return Err(failure(
                        CapabilityFailureKind::Denied,
                        format!("workspace root {} changed after registration", root.handle),
                    ));
                }
                canonical_roots.push((root.handle, canonical));
            }
            let default = canonical_roots
                .iter()
                .find(|(handle, _)| handle == &default_handle)
                .ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::Invalid,
                        "default workspace root is not in the root set",
                    )
                })?;
            let requested = match path {
                None => default.1.clone(),
                Some(path) => {
                    if path.contains('\0') {
                        return Err(failure(
                            CapabilityFailureKind::Invalid,
                            "workspace cwd contains NUL",
                        ));
                    }
                    let path = PathBuf::from(path);
                    let candidate = if path.is_absolute() {
                        path
                    } else {
                        default.1.join(path)
                    };
                    candidate.canonicalize().map_err(io_failure)?
                }
            };
            let (handle, root) = canonical_roots
                .iter()
                .find(|(_, root)| requested.starts_with(root))
                .ok_or_else(|| {
                    failure(
                        CapabilityFailureKind::Denied,
                        "requested cwd escapes the workspace",
                    )
                })?;
            if !requested.is_dir() {
                return Err(failure(
                    CapabilityFailureKind::Invalid,
                    "requested cwd is not a directory",
                ));
            }
            let relative = requested
                .strip_prefix(root)
                .map_err(|_| failure(CapabilityFailureKind::Denied, "cwd escaped its root"))?
                .to_string_lossy()
                .replace(std::path::MAIN_SEPARATOR, "/");
            Ok(CapabilityValue::FileLocator(FileLocator {
                root: FileRoot::Workspace {
                    handle: handle.clone(),
                },
                path: relative,
            }))
        }
    }
}

fn copy_recursive(from: &Path, to: &Path, depth: usize) -> Result<(), CapabilityFailure> {
    if depth > 128 {
        return Err(failure(
            CapabilityFailureKind::TooLarge,
            "copy tree exceeds 128 directory levels",
        ));
    }
    let metadata = fs::symlink_metadata(from).map_err(io_failure)?;
    if metadata.file_type().is_symlink() {
        return Err(failure(
            CapabilityFailureKind::Denied,
            format!("refusing to copy a symbolic link: {}", from.display()),
        ));
    }
    if metadata.is_file() {
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(io_failure)?;
            reject_symlink_chain(parent)?;
        }
        fs::copy(from, to).map_err(io_failure)?;
        return Ok(());
    }
    if metadata.is_dir() {
        fs::create_dir(to).map_err(io_failure)?;
        for entry in fs::read_dir(from).map_err(io_failure)? {
            let entry = entry.map_err(io_failure)?;
            copy_recursive(&entry.path(), &to.join(entry.file_name()), depth + 1)?;
        }
        return Ok(());
    }
    Err(failure(
        CapabilityFailureKind::Invalid,
        format!("unsupported file type: {}", from.display()),
    ))
}

fn machine_roots() -> Vec<FileEntry> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|letter| {
                let drive = format!("{}:\\", letter as char);
                Path::new(&drive).is_dir().then(|| FileEntry {
                    name: format!("{}:", letter as char),
                    kind: FileKind::Directory,
                    bytes: 0,
                    modified_at_millis: None,
                    native_path: Some(drive),
                })
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![FileEntry {
            name: "/".to_string(),
            kind: FileKind::Directory,
            bytes: 0,
            modified_at_millis: None,
            native_path: Some("/".to_string()),
        }]
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
    // `PathBuf::join("")` preserves a trailing separator on Unix. Besides
    // making an otherwise identical capability root compare unequal, that
    // leaked a different path spelling into confinement announcements after
    // the Wasm split. Keep the registered canonical root verbatim when the
    // locator names the root itself.
    let path = if relative.as_os_str().is_empty() {
        root.clone()
    } else {
        root.join(relative)
    };
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
