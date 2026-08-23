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
