//! Starting a process for somebody who is not at this machine, and owning it
//! for exactly as long as they are watching.
//!
//! Two places here start processes on a caller's behalf: a terminal
//! (`pty.rs`) and a command (`exec.rs`). How the output is read differs, and
//! that is genuinely all that differs — how the process is built out of a
//! confinement policy, and what it means to stop it, are the same question
//! twice. They used to be answered twice, which is how one of them came to be
//! answered wrong.
//!
//! **Killing a process does not kill what it started.** `SIGKILL` to a pid
//! reaches that pid. Everything it forked keeps running, reparented to init,
//! and on a machine people leave running that is how a stray dev server holds
//! a port until somebody reboots. The fix is that the child gets a session of
//! its own at birth, so that later there is a name — the process group — for
//! "it and everything it started".
//!
//! Two surfaces, two different right answers about stopping:
//!
//! - A **command** is owned by the request that asked for it. When the caller
//!   goes away the whole group goes with it, because nothing is left that
//!   wanted it.
//! - A **terminal** is not. `nohup foo &` outliving the terminal is what a
//!   terminal has always meant, and a person who typed that meant it. Closing
//!   one hangs it up and stops there.
//!
//! That asymmetry is the reason this module offers the group kill rather than
//! performing it: the policy belongs to the caller, the mechanism belongs
//! here.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::isolation::Policy;

/// The command line to actually launch, once a confinement policy has had its
/// say.
///
/// Confinement is not a flag on the process, it is a different process: our
/// own binary, re-run with a hidden argument, which restricts itself and only
/// then becomes the program (`isolation.rs`). Both callers need that
/// substitution and neither should be the one that remembers it.
pub fn launch_argv(program: &str, confinement: Option<&Policy>) -> Result<Vec<PathBuf>> {
    match confinement {
        None => Ok(vec![PathBuf::from(program)]),
        Some(policy) => policy
            .wrap(Path::new(program))
            .context("building the confinement wrapper"),
    }
}

/// What a child must do to itself between fork and exec.
///
/// Runs in the forked child, where almost nothing is safe: no allocation, no
/// locks, nothing that another thread might have been holding at the moment
/// of the fork. Everything here is a bare syscall for that reason.
#[cfg(unix)]
pub fn detach_child(parent_pid: libc::pid_t) -> std::io::Result<()> {
    own_session()?;
    #[cfg(target_os = "linux")]
    die_with_parent(parent_pid)?;
    #[cfg(not(target_os = "linux"))]
    let _ = parent_pid;
    Ok(())
}

/// Puts the child in a session of its own, so that what it starts has a name.
///
/// A fresh fork is never a process group leader, so this normally succeeds.
/// `EPERM` means it already is one, and then it is already the thing we were
/// trying to make it.
#[cfg(unix)]
fn own_session() -> std::io::Result<()> {
    if unsafe { libc::setsid() } != -1 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() != Some(libc::EPERM) {
        return Err(error);
    }
    if unsafe { libc::setpgid(0, 0) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}

/// Asks the kernel to stop the child if this daemon dies without warning.
///
/// The ordinary paths already stop it. This is for the one that cannot: a
/// daemon killed with `SIGKILL` runs no destructor and closes no connection,
/// and without this its commands would keep going with nobody left who knows
/// about them.
///
/// Two things about it are worth knowing. It is armed after the fork, so the
/// parent may already have died in the gap — hence the re-check, which turns
/// a missed signal into an immediate one. And the kernel counts the forking
/// *thread*, not the process; that is safe here only because the fork happens
/// on a runtime worker, which lives as long as the runtime does.
#[cfg(target_os = "linux")]
fn die_with_parent(parent_pid: libc::pid_t) -> std::io::Result<()> {
    if unsafe { libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) } == -1 {
        return Err(std::io::Error::last_os_error());
    }
    if unsafe { libc::getppid() } != parent_pid {
        unsafe { libc::raise(libc::SIGTERM) };
    }
    Ok(())
}

/// This process's own pid, to be captured *before* the fork.
///
/// Reading it in the child would read the child's.
#[cfg(unix)]
pub fn current_pid() -> libc::pid_t {
    unsafe { libc::getpid() }
}

/// How long a process gets to finish on its own after being asked, before it
/// is made to.
///
/// Only ever waited out by a process that ignores the request; one that honours
/// it is gone in milliseconds and nothing waits for the rest. So this is priced
/// as "how long is it worth holding a person's click before giving up on a
/// clean exit", not as a delay every stop pays.
pub const GRACE: std::time::Duration = std::time::Duration::from_secs(2);

/// How often to look during the grace period. Short enough that the common
/// case — gone almost at once — is not rounded up into a visible pause.
const GRACE_POLL: std::time::Duration = std::time::Duration::from_millis(20);

/// Stops a process and everything it started, immediately.
///
/// The blunt one, for callers with nobody left to wait for them: a peer that
/// disconnected, a `Drop` that cannot await. Where there is somebody waiting,
/// [`end_tree`] asks first.
#[cfg(unix)]
pub fn stop_tree(pid: u32) {
    signal_tree(pid, libc::SIGKILL);
}

/// Asks a process and everything it started to finish, and makes it if it will
/// not.
///
/// `SIGKILL` cannot be caught, so a server killed with it never removes its
/// socket, never writes out what it was holding, and never stops its own
/// children — which is how stopping one thing leaves three behind. `SIGTERM`
/// is the same request phrased so it can be answered, and almost everything
/// worth stopping answers it.
///
/// Returns as soon as the tree is gone, so honouring the request costs nothing.
#[cfg(unix)]
pub async fn end_tree(pid: u32) {
    signal_tree(pid, libc::SIGTERM);
    let deadline = tokio::time::Instant::now() + GRACE;
    while tokio::time::Instant::now() < deadline {
        if !tree_exists(pid) {
            return;
        }
        tokio::time::sleep(GRACE_POLL).await;
    }
    // It was asked and it did not go. Note it: a program that regularly needs
    // this is either wedged or does not handle `SIGTERM`, and both are things
    // worth learning from a log rather than from a user's bug report.
    tracing::debug!(
        pid,
        "a process ignored the request to finish and was stopped"
    );
    signal_tree(pid, libc::SIGKILL);
}

/// Whether there is still anything in the group. A group outlives its leader
/// as long as any member is running, which is exactly the thing being waited
/// out here.
#[cfg(unix)]
fn tree_exists(pid: u32) -> bool {
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group > 0 {
        return true;
    }
    // The leader is gone. Anything else in its group is reachable only through
    // the group number, which is the leader's old pid.
    unsafe { libc::killpg(pid as libc::pid_t, 0) == 0 }
}

/// Signals the group a pid belongs to, whatever that group turns out to be.
///
/// The group is looked up rather than assumed, because this is also used on
/// pids we did not start and which may be ordinary members of somebody else's
/// group. If the pid is gone we stop: guessing that its number was also its
/// group number would, for a process that was never a leader, aim a `SIGKILL`
/// at strangers.
#[cfg(unix)]
fn signal_tree(pid: u32, signal: libc::c_int) {
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group <= 0 {
        return;
    }
    signal_group(group as u32, signal);
}

/// Best effort throughout: every failure here means somebody else already did
/// it.
#[cfg(unix)]
fn signal_group(group: u32, signal: libc::c_int) {
    let group = group as libc::pid_t;
    if unsafe { libc::killpg(group, signal) } == 0 {
        return;
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EPERM) {
        stop_each_member(group, signal);
    }
}

/// macOS refuses `killpg` for a group it will happily let us signal one pid at
/// a time (`EPERM`), which would leave every descendant running. So ask it for
/// the members and take them individually.
///
/// The leader goes last: signalling it first can leave the rest of the group
/// unreachable through it. Every pid is re-checked against the group it was
/// supposed to be in, because a pid learned a moment ago may by now be a
/// different process entirely.
#[cfg(target_os = "macos")]
fn stop_each_member(group: libc::pid_t, signal: libc::c_int) {
    let mut members: Vec<libc::pid_t> = vec![0; 16];
    loop {
        let Ok(size) = libc::c_int::try_from(std::mem::size_of_val(members.as_slice())) else {
            return;
        };
        let found = unsafe { libc::proc_listpgrppids(group, members.as_mut_ptr().cast(), size) };
        if found < 0 {
            return;
        }
        let found = found as usize;
        if found < members.len() {
            members.truncate(found);
            break;
        }
        let Some(larger) = members.len().checked_mul(2) else {
            return;
        };
        members.resize(larger, 0);
    }
    members.sort_unstable_by_key(|member| *member == group);
    for member in members {
        if member <= 0 || unsafe { libc::getpgid(member) } != group {
            continue;
        }
        unsafe { libc::kill(member, signal) };
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
fn stop_each_member(_group: libc::pid_t, _signal: libc::c_int) {}

#[cfg(not(unix))]
pub fn stop_tree(_pid: u32) {}

#[cfg(not(unix))]
pub async fn end_tree(_pid: u32) {}

/// Named once so that the lifecycle below reads as what it does — ask, then
/// insist — on every platform, including the one where neither is a signal.
#[cfg(unix)]
const TERM: libc::c_int = libc::SIGTERM;
#[cfg(unix)]
const KILL: libc::c_int = libc::SIGKILL;
#[cfg(not(unix))]
const TERM: i32 = 15;
#[cfg(not(unix))]
const KILL: i32 = 9;

#[cfg(not(unix))]
fn signal_group(_group: u32, _signal: i32) {}

#[cfg(not(unix))]
fn tree_exists(_pid: u32) -> bool {
    false
}

/// A command configured so that it can later be stopped completely.
///
/// The pieces that have to be in place before the fork are all here, because
/// none of them can be added afterwards: a process cannot be put into its own
/// session once it has children, and a death signal armed late is a death
/// signal that was not armed during the window it was for.
pub fn command(argv: &[PathBuf], arguments: &[String], cwd: &Path) -> tokio::process::Command {
    let (program, wrapper) = argv.split_first().expect("an argv always has a program");
    let mut command = tokio::process::Command::new(program);
    command.args(wrapper).args(arguments).current_dir(cwd);
    own_group(&mut command);
    command
}

/// Gives a command a process group of its own, without taking over the rest of
/// how it is built.
///
/// The callers that assemble their own command — the agent adapters, which
/// have environment, working directory and platform quirks of their own to
/// arrange — need this one thing and nothing else from this module.
pub fn own_group(command: &mut tokio::process::Command) {
    #[cfg(unix)]
    {
        let parent = current_pid();
        // SAFETY: the closure runs in the forked child and touches nothing but
        // syscalls, which is the whole contract of `pre_exec`.
        unsafe {
            command.pre_exec(move || detach_child(parent));
        }
    }
    #[cfg(not(unix))]
    let _ = command;
}

/// A running command, and everything it starts, held together.
///
/// `tokio`'s own `kill_on_drop` stops the process it spawned and nothing
/// below it, which for `bash -lc "npm run dev"` means it stops bash and
/// leaves the server. This stops the group.
pub struct Group {
    child: tokio::process::Child,
    /// Captured at spawn: after the child is reaped its pid is no longer
    /// available, and by then we would be asking too late anyway.
    pid: Option<u32>,
    /// Remembered so that a process is waited for once however many times it
    /// is asked about. Both the normal path and the teardown path want the
    /// exit status, and only the first of them can be the one that reaps it.
    status: Option<std::process::ExitStatus>,
}

impl Group {
    pub fn spawn(command: &mut tokio::process::Command) -> std::io::Result<Self> {
        // Still asked for, so that a child which somehow escapes the group
        // kill is at least reaped rather than left as a zombie.
        let child = command.kill_on_drop(true).spawn()?;
        let pid = child.id();
        Ok(Group {
            child,
            pid,
            status: None,
        })
    }

    /// The process, and so also the group it leads.
    ///
    /// `None` once it has been waited for: the number is only meaningful while
    /// there is something for it to name.
    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn stdin(&mut self) -> Option<tokio::process::ChildStdin> {
        self.child.stdin.take()
    }

    pub fn stdout(&mut self) -> Option<tokio::process::ChildStdout> {
        self.child.stdout.take()
    }

    pub fn stderr(&mut self) -> Option<tokio::process::ChildStderr> {
        self.child.stderr.take()
    }

    pub async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        if let Some(status) = self.status {
            return Ok(status);
        }
        let status = self.child.wait().await?;
        self.status = Some(status);
        Ok(status)
    }

    /// Asks the whole group to finish, and waits until it has.
    ///
    /// For the caller that is still here — a command that ran out of time, a
    /// request being torn down in an async context. `Drop` cannot do this
    /// because it cannot wait, so it keeps the blunt version; this is the one
    /// to reach for whenever there is somewhere to await.
    ///
    /// The exit status comes back where there is one. A command stopped this
    /// way still finished, and what it finished with is the caller's answer.
    pub async fn end(&mut self) -> Option<std::process::ExitStatus> {
        let Some(pid) = self.pid else {
            return self.status;
        };
        // The group number is the pid, because the child was made a session
        // leader at birth. Worth knowing without asking: once the child has
        // been reaped the operating system will no longer say what group it
        // led, and the rest of that group is then only reachable by number.
        signal_group(pid, TERM);

        let deadline = tokio::time::Instant::now() + GRACE;
        // Ours by handle, the rest by polling. A child of ours that has exited
        // stays a zombie in its group until it is reaped, so polling alone
        // would wait out the whole grace period every time — including for the
        // processes that did as they were asked at once.
        let _ = tokio::time::timeout_at(deadline, self.wait()).await;
        while tokio::time::Instant::now() < deadline && tree_exists(pid) {
            tokio::time::sleep(GRACE_POLL).await;
        }

        signal_group(pid, KILL);
        let _ = self.wait().await;
        self.status
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        // Before the inner child drops: `tokio` would kill the one pid and
        // reap it, and a reaped pid can no longer be asked for its group.
        if let Some(pid) = self.pid {
            stop_tree(pid);
        }
    }
}

#[cfg(test)]
#[path = "process_tests.rs"]
mod tests;
