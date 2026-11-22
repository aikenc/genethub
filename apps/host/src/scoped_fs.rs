//! Generic scoped descriptors for confined background file reads.

use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Component, Path};

use cap_fs_ext::{DirExt, FollowSymlinks, OpenOptionsFollowExt};
use cap_std::fs::{Dir, OpenOptions};
use wasmtime::component::Resource;

use crate::bindings::genehub::host::scoped_fs as wit;
use crate::load::Host;

const CHUNK: usize = 128 * 1024;

pub struct Directory(Dir);
pub struct File {
    file: std::fs::File,
    length: u64,
}

fn relative(path: &str) -> Result<&Path, wit::FileError> {
    let path = Path::new(path);
    if path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(wit::FileError::Forbidden);
    }
    Ok(path)
}

fn classify(error: io::Error) -> wit::FileError {
    match error.kind() {
        io::ErrorKind::PermissionDenied => wit::FileError::Forbidden,
        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory => wit::FileError::Missing,
        _ => wit::FileError::Unavailable,
    }
}

impl wit::Host for Host {
    async fn scope(
        &mut self,
        workspace: String,
        root: String,
    ) -> Result<Resource<Directory>, wit::FileError> {
        if matches!(self.worker, crate::worker::State::Disabled) {
            return Err(wit::FileError::Forbidden);
        }
        let workspace = crate::guest_paths::host_path_from_guest(workspace);
        if !workspace.is_absolute() {
            return Err(wit::FileError::Forbidden);
        }
        let parent = workspace.parent().ok_or(wit::FileError::Forbidden)?;
        let name = workspace.file_name().ok_or(wit::FileError::Forbidden)?;
        let mut directory = Dir::open_ambient_dir(parent, cap_std::ambient_authority())
            .and_then(|parent| parent.open_dir_nofollow(name))
            .map_err(classify)?;
        for part in relative(&root)? {
            directory = directory.open_dir_nofollow(part).map_err(classify)?;
        }
        self.table
            .push(Directory(directory))
            .map_err(|_| wit::FileError::Unavailable)
    }
}

impl wit::HostDirectory for Host {
    async fn open(
        &mut self,
        scope: Resource<Directory>,
        path: String,
    ) -> Result<Resource<File>, wit::FileError> {
        let path = relative(&path)?;
        let directory = self
            .table
            .get(&scope)
            .map_err(|_| wit::FileError::Unavailable)?;
        let mut directory = directory.0.try_clone().map_err(classify)?;
        for part in path.parent().into_iter().flat_map(Path::iter) {
            directory = directory.open_dir_nofollow(part).map_err(classify)?;
        }
        let name = path.file_name().ok_or(wit::FileError::Forbidden)?;
        let mut options = OpenOptions::new();
        options.read(true).follow(FollowSymlinks::No);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NONBLOCK);
        }
        let file = directory.open_with(name, &options).map_err(classify)?;
        let metadata = file.metadata().map_err(classify)?;
        if !metadata.is_file() {
            return Err(wit::FileError::Missing);
        }
        self.table
            .push(File {
                file: file.into_std(),
                length: metadata.len(),
            })
            .map_err(|_| wit::FileError::Unavailable)
    }

    async fn drop(&mut self, scope: Resource<Directory>) -> wasmtime::Result<()> {
        self.table.delete(scope)?;
        Ok(())
    }
}

impl wit::HostFile for Host {
    async fn length(&mut self, file: Resource<File>) -> u64 {
        self.table.get(&file).map_or(0, |file| file.length)
    }

    async fn read_at(
        &mut self,
        file: Resource<File>,
        offset: u64,
        max_bytes: u32,
    ) -> Result<Vec<u8>, wit::FileError> {
        let file = self
            .table
            .get_mut(&file)
            .map_err(|_| wit::FileError::Unavailable)?;
        let mut bytes = vec![0; (max_bytes as usize).min(CHUNK)];
        file.file.seek(SeekFrom::Start(offset)).map_err(classify)?;
        let len = file.file.read(&mut bytes).map_err(classify)?;
        bytes.truncate(len);
        Ok(bytes)
    }

    async fn drop(&mut self, file: Resource<File>) -> wasmtime::Result<()> {
        self.table.delete(file)?;
        Ok(())
    }
}
