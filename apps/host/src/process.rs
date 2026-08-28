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

#[derive(Clone, Default)]
struct PipeBuffer(Arc<Mutex<Pipe>>);

impl PipeBuffer {
    /// `None` once the pipe is drained *and* at EOF, so the guest can tell
    /// "finished" from "nothing yet".
    fn take(&self, max: usize) -> Option<Vec<u8>> {
        let mut pipe = self.0.lock().unwrap();
        if pipe.data.is_empty() {
            return if pipe.eof { None } else { Some(Vec::new()) };
        }
        let take = max.min(pipe.data.len());
        Some(pipe.data.drain(..take).collect())
    }

    fn spawn_reader(&self, mut source: impl tokio::io::AsyncRead + Unpin + Send + 'static) {
        let buffer = self.clone();
        tokio::spawn(async move {
            let mut chunk = vec![0u8; 32 * 1024];
            loop {
                match source.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(read) => buffer.0.lock().unwrap().data.extend(&chunk[..read]),
                }
            }
            buffer.0.lock().unwrap().eof = true;
        });
    }
}

pub struct ChildHandle {
    child: tokio::process::Child,
    pid: Option<u32>,
    stdout: PipeBuffer,
    stderr: PipeBuffer,
    stdin: Option<mpsc::Sender<Vec<u8>>>,
}

impl ChildHandle {
    pub fn spawn(
        argv: &[String],
        env: &[(String, String)],
        cwd: Option<&str>,
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
        own_session(&mut command);

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
        signal_group(child.pid, TERM);
        Ok(())
    }

    async fn kill(&mut self, this: Resource<ChildHandle>) -> Result<(), String> {
        let child = self.table.get_mut(&this).map_err(|e| e.to_string())?;
        signal_group(child.pid, KILL);
        // Still asked for, so a child that somehow escaped the group is at
        // least reaped rather than left behind as a zombie.
        let _ = child.child.start_kill();
        Ok(())
    }

    async fn group_alive(&mut self, this: Resource<ChildHandle>) -> bool {
        let Ok(child) = self.table.get_mut(&this) else {
            return false;
        };
        group_alive(child.pid)
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
            signal_group(child.pid, KILL);
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
    ) -> Result<Resource<ChildHandle>, wit::SpawnError> {
        let child = ChildHandle::spawn(&argv, &env, cwd.as_deref())
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

    async fn pid_alive(&mut self, pid: u32) -> bool {
        native_pid_alive(pid)
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
        command.pre_exec(|| {
            if libc::setsid() != -1 {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EPERM) {
                return Err(error);
            }
            if libc::setpgid(0, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
}

#[cfg(not(unix))]
fn own_session(_command: &mut tokio::process::Command) {}

/// Signals the group a pid leads. Best effort: every failure here means the
/// process is already gone, or somebody else already stopped it.
#[cfg(unix)]
fn signal_group(pid: Option<u32>, signal: libc::c_int) {
    let Some(pid) = pid else { return };
    // Looked up rather than assumed: aiming at a pid that never led a group
    // would send the signal to strangers.
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group > 0 {
        unsafe { libc::killpg(group, signal) };
        return;
    }
    // The leader has been reaped. What it started is still reachable by the
    // group number, which is the leader's old pid.
    unsafe { libc::killpg(pid as libc::pid_t, signal) };
}

#[cfg(unix)]
fn group_alive(pid: Option<u32>) -> bool {
    let Some(pid) = pid else { return false };
    if unsafe { libc::getpgid(pid as libc::pid_t) } > 0 {
        return true;
    }
    unsafe { libc::killpg(pid as libc::pid_t, 0) == 0 }
}

#[cfg(not(unix))]
fn signal_group(_pid: Option<u32>, _signal: i32) {}

#[cfg(not(unix))]
fn group_alive(_pid: Option<u32>) -> bool {
    false
}

#[cfg(unix)]
fn native_pid_alive(pid: u32) -> bool {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    unsafe {
        libc::kill(pid, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(windows)]
fn native_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    if pid == 0 {
        return false;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } == ERROR_ACCESS_DENIED;
    }
    unsafe {
        CloseHandle(handle);
    }
    true
}

#[cfg(not(any(unix, windows)))]
fn native_pid_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod pid_tests {
    #[test]
    fn native_pid_probe_distinguishes_current_process_from_impossible_pid() {
        assert!(super::native_pid_alive(std::process::id()));
        #[cfg(unix)]
        assert!(!super::native_pid_alive(i32::MAX as u32));
    }
}
