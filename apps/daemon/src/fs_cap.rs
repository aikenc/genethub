//! Directory capability used by workspace file IO.
//!
//! Native keeps `cap-std` (no-follow lookups). WASI uses the same relative
//! API over `std::fs` after the workspace root has been opened without
//! following a symlink.

use std::path::Path;
#[cfg(target_family = "wasm")]
use std::path::PathBuf;

use anyhow::{Context, Result};

#[cfg(all(not(unix), not(target_family = "wasm")))]
use cap_std::ambient_authority;
#[cfg(not(target_family = "wasm"))]
pub use cap_std::fs::Dir;

#[cfg(target_family = "wasm")]
use std::fs::{self, File};
#[cfg(target_family = "wasm")]
use std::io;

#[cfg(target_family = "wasm")]
#[derive(Clone)]
pub struct Dir {
    root: PathBuf,
}

#[cfg(target_family = "wasm")]
pub struct DirEntry {
    name: std::ffi::OsString,
}

#[cfg(target_family = "wasm")]
impl DirEntry {
    pub fn file_name(&self) -> std::ffi::OsString {
        self.name.clone()
    }
}

#[cfg(target_family = "wasm")]
pub struct OpenFile {
    inner: File,
}

#[cfg(target_family = "wasm")]
impl OpenFile {
    pub fn metadata(&self) -> io::Result<fs::Metadata> {
        self.inner.metadata()
    }

    pub fn into_std(self) -> File {
        self.inner
    }
}

#[cfg(target_family = "wasm")]
impl Dir {
    pub fn open_ambient_dir(path: impl AsRef<Path>) -> io::Result<Self> {
        let root = path.as_ref().to_path_buf();
        let meta = fs::symlink_metadata(&root)?;
        if meta.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "directory is a symbolic link",
            ));
        }
        if !meta.is_dir() {
            return Err(io::Error::new(io::ErrorKind::Other, "not a directory"));
        }
        Ok(Dir { root })
    }

    fn join(&self, relative: &Path) -> PathBuf {
        if relative.as_os_str().is_empty() || relative == Path::new(".") {
            self.root.clone()
        } else {
            self.root.join(relative)
        }
    }

    pub fn metadata(&self, relative: impl AsRef<Path>) -> io::Result<fs::Metadata> {
        fs::metadata(self.join(relative.as_ref()))
    }

    pub fn symlink_metadata(&self, relative: impl AsRef<Path>) -> io::Result<fs::Metadata> {
        fs::symlink_metadata(self.join(relative.as_ref()))
    }

    pub fn open(&self, relative: impl AsRef<Path>) -> io::Result<OpenFile> {
        File::open(self.join(relative.as_ref())).map(|inner| OpenFile { inner })
    }

    pub fn create_dir_all(&self, relative: impl AsRef<Path>) -> io::Result<()> {
        let path = self.join(relative.as_ref());
        if path.as_os_str().is_empty() || path == self.root {
            return Ok(());
        }
        fs::create_dir_all(path)
    }

    pub fn write(&self, relative: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
        fs::write(self.join(relative.as_ref()), contents)
    }

    pub fn rename(
        &self,
        from: impl AsRef<Path>,
        _to_dir: &Self,
        to: impl AsRef<Path>,
    ) -> io::Result<()> {
        fs::rename(self.join(from.as_ref()), self.join(to.as_ref()))
    }

    pub fn remove_file(&self, relative: impl AsRef<Path>) -> io::Result<()> {
        fs::remove_file(self.join(relative.as_ref()))
    }

    pub fn remove_dir_all(&self, relative: impl AsRef<Path>) -> io::Result<()> {
        fs::remove_dir_all(self.join(relative.as_ref()))
    }

    pub fn copy(
        &self,
        from: impl AsRef<Path>,
        _to_dir: &Self,
        to: impl AsRef<Path>,
    ) -> io::Result<u64> {
        fs::copy(self.join(from.as_ref()), self.join(to.as_ref()))
    }

    pub fn read_dir(&self, relative: impl AsRef<Path>) -> io::Result<ReadDir> {
        Ok(ReadDir {
            inner: fs::read_dir(self.join(relative.as_ref()))?,
        })
    }
}

#[cfg(target_family = "wasm")]
pub struct ReadDir {
    inner: fs::ReadDir,
}

#[cfg(target_family = "wasm")]
impl Iterator for ReadDir {
    type Item = io::Result<DirEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next().map(|entry| {
            entry.map(|entry| DirEntry {
                name: entry.file_name(),
            })
        })
    }
}

pub fn open_workspace_root(root: &Path) -> Result<Dir> {
    #[cfg(all(unix, not(target_family = "wasm")))]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let file = std::fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(root)
            .with_context(|| format!("opening workspace root {}", root.display()))?;
        Ok(Dir::from_std_file(file))
    }

    #[cfg(all(not(unix), not(target_family = "wasm")))]
    {
        let metadata = std::fs::symlink_metadata(root)
            .with_context(|| format!("reading workspace root {}", root.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!("workspace root is a symbolic link");
        }
        Dir::open_ambient_dir(root, ambient_authority())
            .with_context(|| format!("opening workspace root {}", root.display()))
    }

    #[cfg(target_family = "wasm")]
    {
        let metadata = std::fs::symlink_metadata(root)
            .with_context(|| format!("reading workspace root {}", root.display()))?;
        if metadata.file_type().is_symlink() {
            anyhow::bail!("workspace root is a symbolic link");
        }
        Dir::open_ambient_dir(root)
            .with_context(|| format!("opening workspace root {}", root.display()))
    }
}

#[cfg(not(target_family = "wasm"))]
pub(crate) type PreviewReader = std::fs::File;

/// Open the source once under a directory capability. The returned descriptor
/// owns metadata, hashing and streaming; callers never reopen an ambient path.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn open_preview(
    root: &Path,
    relative: &Path,
) -> std::io::Result<(PreviewReader, u64, bool)> {
    let directory = open_workspace_root(root).map_err(std::io::Error::other)?;
    let mut options = cap_std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use cap_std::fs::OpenOptionsExt;
        // A raced FIFO must not block before the regular-file check below.
        options.custom_flags(libc::O_NONBLOCK);
    }
    let file = directory.open_with(relative, &options)?;
    let metadata = file.metadata()?;
    Ok((file.into_std(), metadata.len(), metadata.is_file()))
}

/// Enumerate a legacy feedback store under its registered project capability.
/// A replaced ancestor cannot turn migration into an ambient disk scan.
#[cfg(not(target_family = "wasm"))]
pub(crate) fn preview_entries(
    root: &Path,
    relative: &Path,
) -> std::io::Result<Vec<(String, bool)>> {
    let directory = open_workspace_root(root).map_err(std::io::Error::other)?;
    let mut names = Vec::new();
    for entry in directory.read_dir(relative)? {
        let entry = entry?;
        if names.len() >= 100_000 {
            return Err(std::io::Error::other("too many feedback entries"));
        }
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "legacy feedback contains a link",
            ));
        }
        if kind.is_dir() || kind.is_file() {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| std::io::Error::other("non-UTF8 feedback name"))?;
            names.push((name, kind.is_dir()));
        }
    }
    Ok(names)
}

#[cfg(target_family = "wasm")]
pub(crate) fn preview_entries(
    root: &Path,
    relative: &Path,
) -> std::io::Result<Vec<(String, bool)>> {
    use wasi::filesystem::types::DescriptorType;
    let (reader, _, _) = open_preview(root, relative)?;
    let entries = reader.descriptor.read_directory().map_err(wasi_io)?;
    let mut names = Vec::new();
    while let Some(entry) = entries.read_directory_entry().map_err(wasi_io)? {
        if entry.name == "." || entry.name == ".." {
            continue;
        }
        if names.len() >= 100_000 {
            return Err(std::io::Error::other("too many feedback entries"));
        }
        if entry.type_ == DescriptorType::SymbolicLink {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "legacy feedback contains a link",
            ));
        }
        if matches!(
            entry.type_,
            DescriptorType::Directory | DescriptorType::RegularFile
        ) {
            names.push((entry.name, entry.type_ == DescriptorType::Directory));
        }
    }
    Ok(names)
}

/// WASI's ambient std::fs starts at the whole-volume preopen. Hold each child
/// directory descriptor instead, and never follow a symlink while descending.
/// This closes the check/open race even when a directory is replaced mid-read.
#[cfg(target_family = "wasm")]
#[derive(Debug)]
pub(crate) struct PreviewReader {
    descriptor: wasi::filesystem::types::Descriptor,
    offset: u64,
    length: u64,
}

#[cfg(target_family = "wasm")]
fn wasi_io(error: wasi::filesystem::types::ErrorCode) -> std::io::Error {
    use wasi::filesystem::types::ErrorCode;
    let kind = match error {
        ErrorCode::NoEntry => std::io::ErrorKind::NotFound,
        ErrorCode::Access | ErrorCode::NotPermitted | ErrorCode::Loop => {
            std::io::ErrorKind::PermissionDenied
        }
        _ => std::io::ErrorKind::Other,
    };
    std::io::Error::new(kind, format!("capability file open: {error:?}"))
}

#[cfg(target_family = "wasm")]
pub(crate) fn open_preview(
    root: &Path,
    relative: &Path,
) -> std::io::Result<(PreviewReader, u64, bool)> {
    use wasi::filesystem::{
        preopens,
        types::{DescriptorFlags, DescriptorType, OpenFlags, PathFlags},
    };
    let mut mounts = preopens::get_directories();
    mounts.sort_by_key(|(_, name)| std::cmp::Reverse(name.len()));
    let (mut directory, tail) = mounts
        .into_iter()
        .find_map(|(dir, name)| {
            root.strip_prefix(Path::new(&name))
                .ok()
                .map(|tail| (dir, tail.to_owned()))
        })
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::PermissionDenied, "root has no preopen")
        })?;
    for component in tail.components().chain(relative.components()) {
        let std::path::Component::Normal(name) = component else {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "non-canonical capability path",
            ));
        };
        let name = name.to_str().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "non-UTF8 path")
        })?;
        // Empty PathFlags means NO symlink-follow, on every component. A held
        // parent descriptor also prevents an ancestor rename escaping the root.
        directory = directory
            .open_at(
                PathFlags::empty(),
                name,
                OpenFlags::empty(),
                DescriptorFlags::READ,
            )
            .map_err(wasi_io)?;
    }
    let stat = directory.stat().map_err(wasi_io)?;
    let regular = stat.type_ == DescriptorType::RegularFile;
    Ok((
        PreviewReader {
            descriptor: directory,
            offset: 0,
            length: stat.size,
        },
        stat.size,
        regular,
    ))
}

#[cfg(target_family = "wasm")]
impl std::io::Read for PreviewReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let (bytes, _) = self
            .descriptor
            .read(buffer.len() as u64, self.offset)
            .map_err(wasi_io)?;
        if bytes.len() > buffer.len() {
            return Err(std::io::Error::other("oversized descriptor read"));
        }
        buffer[..bytes.len()].copy_from_slice(&bytes);
        self.offset += bytes.len() as u64;
        Ok(bytes.len())
    }
}

#[cfg(target_family = "wasm")]
impl std::io::Seek for PreviewReader {
    fn seek(&mut self, position: std::io::SeekFrom) -> std::io::Result<u64> {
        let next = match position {
            std::io::SeekFrom::Start(offset) => Some(offset),
            std::io::SeekFrom::Current(delta) => self.offset.checked_add_signed(delta),
            std::io::SeekFrom::End(delta) => self.length.checked_add_signed(delta),
        }
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid file offset")
        })?;
        self.offset = next;
        Ok(next)
    }
}
