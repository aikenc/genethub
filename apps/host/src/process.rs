//! The `process` import: spawn a native OS process on the guest's behalf.
//!
//! WASI has no exec (WASI#899), so this is the shell's job and stays permanent.
//!
//! Every operation is non-blocking, which is the whole point. An import that
//! awaits suspends the guest fiber, and with it every session the daemon is
//! serving, so nothing here may wait on a child. Reads are served from buffers
//! that background tasks fill; writes go to a bounded channel a background task
//! drains. The guest polls and backs off on a timer.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;
use wasmtime::component::Resource;

/// Bytes a background reader has pulled off a pipe but the guest has not taken.
#[derive(Default)]
struct Pipe {
    data: VecDeque<u8>,
    eof: bool,
}

const PIPE_BUFFER_BYTES: usize = 128 * 1024;

#[derive(Default)]
struct PipeBuffer {
    pipe: Arc<Mutex<Pipe>>,
    space: Arc<tokio::sync::Notify>,
    reader: Mutex<Option<tokio::task::JoinHandle<()>>>,
}
impl Drop for PipeBuffer {
    fn drop(&mut self) {
        if let Some(reader) = self.reader.get_mut().unwrap().take() {
            reader.abort();
        }
    }
}

impl PipeBuffer {
    /// `None` once the pipe is drained *and* at EOF, so the guest can tell
    /// "finished" from "nothing yet".
    fn take(&self, max: usize) -> Option<Vec<u8>> {
        let mut pipe = self.pipe.lock().unwrap();
        if pipe.data.is_empty() {
            return if pipe.eof { None } else { Some(Vec::new()) };
        }
        let take = max.min(pipe.data.len());
        let bytes = pipe.data.drain(..take).collect();
        drop(pipe);
        self.space.notify_one();
        Some(bytes)
    }

    fn spawn_reader(&self, mut source: impl tokio::io::AsyncRead + Unpin + Send + 'static) {
        let buffer = self.pipe.clone();
        let space = self.space.clone();
        let reader = tokio::spawn(async move {
            let mut chunk = vec![0u8; 32 * 1024];
            loop {
                let available = PIPE_BUFFER_BYTES - buffer.lock().unwrap().data.len();
                if available == 0 {
                    space.notified().await;
                    continue;
                }
                let limit = available.min(chunk.len());
                match source.read(&mut chunk[..limit]).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => buffer.lock().unwrap().data.extend(&chunk[..read]),
                }
            }
            buffer.lock().unwrap().eof = true;
        });
        if let Some(previous) = self.reader.lock().unwrap().replace(reader) {
            previous.abort();
        }
    }
}

pub struct ChildHandle {
    child: tokio::process::Child,
    pid: Option<u32>,
    own_group: bool,
    stdout: PipeBuffer,
    stderr: PipeBuffer,
    stdin: Option<mpsc::Sender<Vec<u8>>>,
}

impl ChildHandle {
    pub fn spawn(
        argv: &[String],
        env: &[(String, String)],
        cwd: Option<&str>,
        independent_session: bool,
    ) -> Result<Self, String> {
        let (program, arguments) = argv.split_first().ok_or("empty argv")?;
        let mut command =
            tokio::process::Command::new(crate::guest_paths::host_path_from_guest(program));
        command
            .args(arguments)
            .envs(
                env.iter()
                    .map(|(k, v)| (k.as_str(), crate::guest_paths::env_value_for_host(v))),
            )
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if let Some(cwd) = cwd {
            command.current_dir(crate::guest_paths::host_path_from_guest(cwd));
        }
        if independent_session {
            own_session(&mut command);
        }

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let pid = child.id();

        let stdout = PipeBuffer::default();
        if let Some(pipe) = child.stdout.take() {
            stdout.spawn_reader(pipe);
        }
        let stderr = PipeBuffer::default();
        if let Some(pipe) = child.stderr.take() {
            stderr.spawn_reader(pipe);
        }

        // A bounded channel is what gives the guest backpressure: a full channel
        // makes `write-stdin` report zero bytes accepted rather than buffer
        // without limit behind a child that is not reading.
        let stdin = child.stdin.take().map(|mut pipe| {
            let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(64);
            tokio::spawn(async move {
                while let Some(data) = receiver.recv().await {
                    if pipe.write_all(&data).await.is_err() {
                        break;
                    }
                    let _ = pipe.flush().await;
                }
                drop(pipe);
            });
            sender
        });

        Ok(ChildHandle {
            child,
            pid,
            own_group: independent_session,
            stdout,
            stderr,
            stdin,
        })
    }
}

use crate::bindings::genehub::host::process as wit;

impl wit::HostChild for crate::load::Host {
    async fn id(&mut self, this: Resource<ChildHandle>) -> Option<u32> {
        self.table.get(&this).ok().and_then(|child| child.pid)
    }

    async fn read_stdout(
        &mut self,
        this: Resource<ChildHandle>,
        max: u32,
    ) -> Result<Option<Vec<u8>>, String> {
        let child = self.table.get(&this).map_err(|e| e.to_string())?;
        Ok(child.stdout.take(max as usize))
    }

    async fn read_stderr(
        &mut self,
        this: Resource<ChildHandle>,
        max: u32,
    ) -> Result<Option<Vec<u8>>, String> {
        let child = self.table.get(&this).map_err(|e| e.to_string())?;
        Ok(child.stderr.take(max as usize))
    }

    async fn write_stdin(
        &mut self,
        this: Resource<ChildHandle>,
        data: Vec<u8>,
    ) -> Result<u32, String> {
        let child = self.table.get(&this).map_err(|e| e.to_string())?;
        let Some(stdin) = child.stdin.as_ref() else {
            return Err("stdin is closed".into());
        };
        let len = data.len() as u32;
        match stdin.try_send(data) {
            Ok(()) => Ok(len),
            Err(mpsc::error::TrySendError::Full(_)) => Ok(0),
            Err(mpsc::error::TrySendError::Closed(_)) => Err("stdin is closed".into()),
        }
    }

    async fn close_stdin(&mut self, this: Resource<ChildHandle>) -> Result<(), String> {
        let child = self.table.get_mut(&this).map_err(|e| e.to_string())?;
        child.stdin = None;
        Ok(())
    }

    async fn terminate(&mut self, this: Resource<ChildHandle>) -> Result<(), String> {
        let child = self.table.get_mut(&this).map_err(|e| e.to_string())?;
        child.stop(TERM);
        Ok(())
    }

    async fn kill(&mut self, this: Resource<ChildHandle>) -> Result<(), String> {
        let child = self.table.get_mut(&this).map_err(|e| e.to_string())?;
        child.stop(KILL);
        // Still asked for, so a child that somehow escaped the group is at
        // least reaped rather than left behind as a zombie.
        let _ = child.child.start_kill();
        Ok(())
    }

    async fn group_alive(&mut self, this: Resource<ChildHandle>) -> bool {
        let Ok(child) = self.table.get_mut(&this) else {
            return false;
        };
        child.still_alive()
    }

    async fn try_wait(&mut self, this: Resource<ChildHandle>) -> Result<Option<u32>, String> {
        let child = self.table.get_mut(&this).map_err(|e| e.to_string())?;
        match child.child.try_wait().map_err(|error| error.to_string())? {
            None => Ok(None),
            Some(status) => Ok(Some(status.code().unwrap_or(-1) as u32)),
        }
    }

    async fn drop(&mut self, this: Resource<ChildHandle>) -> wasmtime::Result<()> {
        // Before the child itself drops: `kill_on_drop` would stop the one pid
        // and reap it, and a reaped pid can no longer be asked what group it
        // led. The rest of the group would then be unreachable.
        if let Ok(child) = self.table.get(&this) {
            if child.own_group {
                signal_group(child.pid, KILL);
            }
        }
        let _ = self.table.delete(this);
        Ok(())
    }
}

impl wit::Host for crate::load::Host {
    async fn spawn(
        &mut self,
        argv: Vec<String>,
        env: Vec<(String, String)>,
        cwd: Option<String>,
        independent_session: bool,
    ) -> Result<Resource<ChildHandle>, wit::SpawnError> {
        let child = ChildHandle::spawn(&argv, &env, cwd.as_deref(), independent_session)
            .map_err(|message| wit::SpawnError { message })?;
        self.table.push(child).map_err(|error| wit::SpawnError {
            message: error.to_string(),
        })
    }

    async fn locate(&mut self, name: String, extra: Vec<String>) -> Option<String> {
        let extra: Vec<std::path::PathBuf> = extra.into_iter().map(Into::into).collect();
        genet_native::locate::find_executable_in(&name, &extra)
            .map(|path| path.to_string_lossy().into_owned())
    }

    async fn scratch_dir(&mut self) -> String {
        crate::guest_paths::env_value_for_guest(std::env::temp_dir().to_string_lossy())
    }
}

#[cfg(unix)]
const TERM: libc::c_int = libc::SIGTERM;
#[cfg(unix)]
const KILL: libc::c_int = libc::SIGKILL;
#[cfg(not(unix))]
const TERM: i32 = 15;
#[cfg(not(unix))]
const KILL: i32 = 9;

/// Puts the child in a session of its own between fork and exec, so that
/// everything it goes on to start shares one name.
///
/// A fresh fork is never a group leader, so `setsid` normally succeeds; `EPERM`
/// means it already is one, which is what we were asking for anyway.
#[cfg(unix)]
fn own_session(command: &mut tokio::process::Command) {
    // SAFETY: the closure runs in the forked child, where only
    // async-signal-safe syscalls are allowed. These two are.
    unsafe {
        command.pre_exec(genet_native::process_group::own_session);
    }
}

#[cfg(not(unix))]
fn own_session(_command: &mut tokio::process::Command) {}

/// Signals the group a pid leads. Best effort: every failure here means the
/// process is already gone, or somebody else already stopped it.
///
/// Only for a child that leads its own session. A child that shares the
/// agent's group is signaled by pid, so a shell stop cannot take the host
/// with it.
#[cfg(unix)]
fn signal_one(pid: Option<u32>, signal: libc::c_int) {
    let Some(pid) = pid else { return };
    unsafe { libc::kill(pid as libc::pid_t, signal) };
}

#[cfg(unix)]
impl ChildHandle {
    fn stop(&self, signal: libc::c_int) {
        if self.own_group {
            signal_group(self.pid, signal);
        } else {
            signal_one(self.pid, signal);
        }
    }

    fn still_alive(&self) -> bool {
        if self.own_group {
            return group_alive(self.pid);
        }
        let Some(pid) = self.pid else { return false };
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
}

#[cfg(not(unix))]
impl ChildHandle {
    fn stop(&self, _signal: i32) {}

    fn still_alive(&self) -> bool {
        false
    }
}
#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: libc::c_int) {
    if let Some(pid) = pid {
        genet_native::process_group::signal_owned(pid, signal);
    }
}
#[cfg(unix)]
fn group_alive(pid: Option<u32>) -> bool {
    pid.is_some_and(genet_native::process_group::tree_exists)
}

#[cfg(not(unix))]
fn signal_group(_pid: Option<u32>, _signal: i32) {}

#[cfg(not(unix))]
fn group_alive(_pid: Option<u32>) -> bool {
    false
}
