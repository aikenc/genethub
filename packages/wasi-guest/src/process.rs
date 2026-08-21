//! Process spawn, in `tokio::process`'s shape, over the shell's import.
//!
//! WASI has no exec (WASI#899), so the host does the spawning and hands back a
//! `child` resource. Every method on it answers immediately; waiting is this
//! module's job.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fmt;
use std::io;
use std::path::Path;
use std::pin::Pin;
use std::process::Stdio;
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

use crate::poll::{Backoff, IDLE_POLL};
use crate::wit::genehub::host::process as host;

const CHUNK: u32 = 64 * 1024;

struct Entry {
    child: host::Child,
    refs: usize,
}

thread_local! {
    static CHILDREN: RefCell<HashMap<u64, Entry>> = RefCell::new(HashMap::new());
    static NEXT: Cell<u64> = const { Cell::new(1) };
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::BrokenPipe, "the child process is gone")
}

fn with_child<R>(id: u64, f: impl FnOnce(&host::Child) -> R) -> io::Result<R> {
    CHILDREN.with_borrow(|map| map.get(&id).map(|entry| f(&entry.child)).ok_or_else(gone))
}

/// A refcounted claim on a spawned child. `Child` and each of its three
/// streams hold one, because the daemon routinely takes the streams and
/// keeps them past the `Child` value itself.
struct Handle(u64);

impl Handle {
    fn share(&self) -> Handle {
        CHILDREN.with_borrow_mut(|map| {
            if let Some(entry) = map.get_mut(&self.0) {
                entry.refs += 1;
            }
        });
        Handle(self.0)
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        CHILDREN.with_borrow_mut(|map| {
            let Some(entry) = map.get_mut(&self.0) else {
                return;
            };
            entry.refs -= 1;
            if entry.refs == 0 {
                // Dropping the resource is what reaps the process: the host
                // kills the group so nothing is left behind.
                map.remove(&self.0);
            }
        });
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Pipe {
    Stdout,
    Stderr,
}

/// `Ok(None)` is EOF; `Ok(Some(empty))` means nothing is buffered yet.
fn read_once(id: u64, pipe: Pipe, max: u32) -> io::Result<Option<Vec<u8>>> {
    let result = with_child(id, |child| match pipe {
        Pipe::Stdout => child.read_stdout(max),
        Pipe::Stderr => child.read_stderr(max),
    })?;
    result.map_err(io::Error::other)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct ExitStatus(u32);

impl ExitStatus {
    pub fn code(&self) -> Option<i32> {
        Some(self.0 as i32)
    }

    pub fn success(&self) -> bool {
        self.0 == 0
    }
}

impl fmt::Display for ExitStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "exit status: {}", self.0)
    }
}

pub struct Output {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

pub struct Command {
    argv: Vec<String>,
    env: Vec<(String, String)>,
    cwd: Option<String>,
}

impl Command {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Command {
            argv: vec![program.as_ref().to_string_lossy().into_owned()],
            env: Vec::new(),
            cwd: None,
        }
    }

    pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self {
        self.argv.push(arg.as_ref().to_string_lossy().into_owned());
        self
    }

    pub fn args<I, S>(&mut self, args: I) -> &mut Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        for arg in args {
            self.arg(arg);
        }
        self
    }

    pub fn current_dir(&mut self, dir: impl AsRef<Path>) -> &mut Self {
        self.cwd = Some(dir.as_ref().to_string_lossy().into_owned());
        self
    }

    pub fn env(&mut self, key: impl AsRef<OsStr>, val: impl AsRef<OsStr>) -> &mut Self {
        self.env.push((
            key.as_ref().to_string_lossy().into_owned(),
            val.as_ref().to_string_lossy().into_owned(),
        ));
        self
    }

    pub fn envs<I, K, V>(&mut self, vars: I) -> &mut Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<OsStr>,
        V: AsRef<OsStr>,
    {
        for (key, val) in vars {
            self.env(key, val);
        }
        self
    }

    /// Only clears what this builder set. The shell's own environment is
    /// the child's baseline and the guest cannot take it away.
    pub fn env_clear(&mut self) -> &mut Self {
        self.env.clear();
        self
    }

    pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self {
        let key = key.as_ref().to_string_lossy().into_owned();
        self.env.retain(|(name, _)| *name != key);
        self
    }

    /// Every stream is a pipe here. `Stdio::null()` is accepted and treated
    /// as a pipe nobody reads, which is indistinguishable to the child.
    pub fn stdin(&mut self, _cfg: impl Into<Stdio>) -> &mut Self {
        self
    }

    pub fn stdout(&mut self, _cfg: impl Into<Stdio>) -> &mut Self {
        self
    }

    pub fn stderr(&mut self, _cfg: impl Into<Stdio>) -> &mut Self {
        self
    }

    /// The host already kills the group when the last handle drops.
    pub fn kill_on_drop(&mut self, _kill: bool) -> &mut Self {
        self
    }

    /// There is no fork to run between, and the shell gives every child its
    /// own process group anyway.
    pub unsafe fn pre_exec<F>(&mut self, _f: F) -> &mut Self
    where
        F: FnMut() -> io::Result<()> + Send + Sync + 'static,
    {
        self
    }

    pub fn spawn(&mut self) -> io::Result<Child> {
        let child = host::spawn(&self.argv, &self.env, self.cwd.as_deref())
            .map_err(|error| io::Error::other(error.message))?;
        let pid = child.id();
        let id = NEXT.with(|next| {
            let value = next.get();
            next.set(value + 1);
            value
        });
        CHILDREN.with_borrow_mut(|map| map.insert(id, Entry { child, refs: 1 }));
        let handle = Handle(id);
        Ok(Child {
            stdin: Some(ChildStdin {
                handle: handle.share(),
                delay: Backoff::new(),
            }),
            stdout: Some(ChildStdout {
                handle: handle.share(),
                pipe: Pipe::Stdout,
                delay: Backoff::new(),
            }),
            stderr: Some(ChildStderr(ChildStdout {
                handle: handle.share(),
                pipe: Pipe::Stderr,
                delay: Backoff::new(),
            })),
            handle,
            pid,
        })
    }

    pub async fn output(&mut self) -> io::Result<Output> {
        self.spawn()?.wait_with_output().await
    }

    pub async fn status(&mut self) -> io::Result<ExitStatus> {
        self.spawn()?.wait().await
    }
}

pub struct Child {
    handle: Handle,
    pid: Option<u32>,
    pub stdin: Option<ChildStdin>,
    pub stdout: Option<ChildStdout>,
    pub stderr: Option<ChildStderr>,
}

impl Child {
    pub fn id(&self) -> Option<u32> {
        self.pid
    }

    /// Asks the whole group to finish. Returns at once; the caller waits by
    /// polling [`Child::group_alive`].
    pub fn terminate(&mut self) -> io::Result<()> {
        with_child(self.handle.0, host::Child::terminate)?.map_err(io::Error::other)
    }

    /// Stops the whole group. Named for `tokio::process::Child`, which the
    /// daemon's shared code calls through.
    pub fn start_kill(&mut self) -> io::Result<()> {
        with_child(self.handle.0, host::Child::kill)?.map_err(io::Error::other)
    }

    pub fn group_alive(&self) -> bool {
        with_child(self.handle.0, host::Child::group_alive).unwrap_or(false)
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let result = with_child(self.handle.0, host::Child::try_wait)?;
        result
            .map(|code| code.map(ExitStatus))
            .map_err(io::Error::other)
    }

    pub async fn wait(&mut self) -> io::Result<ExitStatus> {
        self.stdin = None;
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(status);
            }
            tokio::time::sleep(IDLE_POLL).await;
        }
    }

    pub async fn wait_with_output(mut self) -> io::Result<Output> {
        let id = self.handle.0;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut out_open = self.stdout.is_some();
        let mut err_open = self.stderr.is_some();
        let mut status = None;
        self.stdin = None;

        loop {
            let mut moved = false;
            for (open, sink, pipe) in [
                (&mut out_open, &mut stdout, Pipe::Stdout),
                (&mut err_open, &mut stderr, Pipe::Stderr),
            ] {
                if !*open {
                    continue;
                }
                match read_once(id, pipe, CHUNK)? {
                    None => {
                        *open = false;
                        moved = true;
                    }
                    Some(chunk) if !chunk.is_empty() => {
                        sink.extend_from_slice(&chunk);
                        moved = true;
                    }
                    Some(_) => {}
                }
            }
            if status.is_none() {
                status = self.try_wait()?;
                moved |= status.is_some();
            }
            // The pipes have to reach EOF before the exit code is reported,
            // or output written just before exit would be dropped.
            if !out_open && !err_open {
                if let Some(status) = status {
                    return Ok(Output {
                        status,
                        stdout,
                        stderr,
                    });
                }
            }
            if !moved {
                tokio::time::sleep(IDLE_POLL).await;
            }
        }
    }
}

pub struct ChildStdin {
    handle: Handle,
    delay: Backoff,
}

pub struct ChildStdout {
    handle: Handle,
    pipe: Pipe,
    delay: Backoff,
}

pub struct ChildStderr(ChildStdout);

impl AsyncWrite for ChildStdin {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let me = self.get_mut();
        if me.delay.waiting(cx) {
            return Poll::Pending;
        }
        let written = with_child(me.handle.0, |child| child.write_stdin(buf))?
            .map_err(io::Error::other)?;
        if written == 0 && !buf.is_empty() {
            return me.delay.idle(cx);
        }
        Poll::Ready(Ok(written as usize))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        match with_child(me.handle.0, host::Child::close_stdin) {
            // A child that already exited is not a shutdown failure.
            Err(_) => Poll::Ready(Ok(())),
            Ok(result) => Poll::Ready(result.map_err(io::Error::other)),
        }
    }
}

impl AsyncRead for ChildStdout {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let me = self.get_mut();
        if me.delay.waiting(cx) {
            return Poll::Pending;
        }
        let want = (buf.remaining() as u32).min(CHUNK);
        if want == 0 {
            return Poll::Ready(Ok(()));
        }
        match read_once(me.handle.0, me.pipe, want)? {
            // Leaving the buffer untouched is how `AsyncRead` says EOF.
            None => Poll::Ready(Ok(())),
            Some(chunk) if chunk.is_empty() => me.delay.idle(cx),
            Some(chunk) => {
                buf.put_slice(&chunk);
                Poll::Ready(Ok(()))
            }
        }
    }
}

impl AsyncRead for ChildStderr {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}
