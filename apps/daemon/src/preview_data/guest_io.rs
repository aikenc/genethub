//! Adapt nonblocking host transport and scoped file descriptors for Hyper.

use std::io;
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use genet_wasi::poll::{self, Backoff};
use genet_wasi::wit::genehub::host::{scoped_fs, tls_server};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub(super) type Dir = scoped_fs::Directory;

pub(super) struct File {
    file: scoped_fs::File,
    offset: u64,
}

impl File {
    pub(super) fn at(mut self, offset: u64) -> Self {
        self.offset = offset;
        self
    }
}

impl AsyncRead for File {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        std::task::ready!(tokio::task::coop::poll_proceed(cx)).made_progress();
        let chunk = self
            .file
            .read_at(self.offset, length(buf.remaining()))
            .map_err(file_error)?;
        self.offset += chunk.len() as u64;
        buf.put_slice(&chunk);
        Poll::Ready(Ok(()))
    }
}

fn length(size: usize) -> u32 {
    size.min(128 * 1024) as u32
}

fn file_error(error: scoped_fs::FileError) -> io::Error {
    match error {
        scoped_fs::FileError::Forbidden => io::ErrorKind::PermissionDenied.into(),
        scoped_fs::FileError::Missing => io::ErrorKind::NotFound.into(),
        scoped_fs::FileError::Unavailable => io::Error::other("file unavailable"),
    }
}

pub(super) fn open_site(workspace: &Path, root: &Path) -> io::Result<Dir> {
    scoped_fs::scope(&workspace.to_string_lossy(), &wire(root)).map_err(file_error)
}

pub(super) fn open_file(directory: &Dir, path: &Path) -> io::Result<(File, u64)> {
    let file = directory.open(&wire(path)).map_err(file_error)?;
    let size = file.length();
    Ok((File { file, offset: 0 }, size))
}

fn wire(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

pub(super) struct Tls {
    connection: tls_server::Connection,
    reading: Backoff,
    writing: Backoff,
}

impl Tls {
    pub(super) fn into_connection(self) -> tls_server::Connection {
        self.connection
    }

    pub(super) async fn open(connection: tls_server::Connection) -> io::Result<(Self, String)> {
        loop {
            if let Some(host) = connection.poll_server_name().map_err(io::Error::other)? {
                return Ok((
                    Self {
                        connection,
                        reading: Backoff::new(),
                        writing: Backoff::new(),
                    },
                    host,
                ));
            }
            poll::idle().await;
        }
    }
}

impl AsyncRead for Tls {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.reading.waiting(cx) {
            return Poll::Pending;
        }
        match self
            .connection
            .read(length(buf.remaining()))
            .map_err(io::Error::other)?
        {
            tls_server::ReadResult::Pending => self.reading.idle(cx),
            tls_server::ReadResult::Closed => Poll::Ready(Ok(())),
            tls_server::ReadResult::Data(data) => {
                buf.put_slice(&data);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncWrite for Tls {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        if buf.is_empty() {
            return Poll::Ready(Ok(0));
        }
        if self.writing.waiting(cx) {
            return Poll::Pending;
        }
        match self
            .connection
            .write(&buf[..length(buf.len()) as usize])
            .map_err(io::Error::other)?
        {
            0 => self.writing.idle(cx),
            written => Poll::Ready(Ok(written as usize)),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.writing.waiting(cx) {
            return Poll::Pending;
        }
        if self.connection.flush().map_err(io::Error::other)? {
            Poll::Ready(Ok(()))
        } else {
            self.writing.idle(cx)
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        if self.writing.waiting(cx) {
            return Poll::Pending;
        }
        if self.connection.shutdown().map_err(io::Error::other)? {
            Poll::Ready(Ok(()))
        } else {
            self.writing.idle(cx)
        }
    }
}
