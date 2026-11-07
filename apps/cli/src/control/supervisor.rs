//! Linux manual-daemon lifecycle. The Host may die without running any Drop.
//! A separate, small subreaper owns its OS descendants, including setsid/double
//! forks. It clears the old tree before starting another Host. No Session or
//! Agent knowledge belongs here. Services and desktop foreground runs retain
//! their existing owner; this entry is used only by `daemon start`.

use std::fs::{File, OpenOptions};
use std::io;
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::process::CommandExt;
use std::process::{Child, Command, Stdio};

use fs2::FileExt;

use super::*;

const LOCK: &str = "daemon-supervisor.lock";
const STOP: &str = "daemon-supervisor.stop";
const POLL: Duration = Duration::from_millis(50);

fn lock_file(paths: &Paths, name: &str) -> io::Result<File> {
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(paths.root.join(name))?;
    genet_frontdoor::perms::restrict_to_owner(&paths.root.join(name)).map_err(io::Error::other)?;
    Ok(file)
}

fn launch_lock(paths: &Paths) -> io::Result<File> {
    let file = lock_file(paths, "daemon-start.lock")?;
    let deadline = Instant::now() + START_TIMEOUT;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(e) if e.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline => {
                std::thread::sleep(POLL);
            }
            Err(e) => return Err(e),
        }
    }
}

fn running(paths: &Paths) -> io::Result<bool> {
    let file = lock_file(paths, LOCK)?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(e) if e.kind() == io::ErrorKind::WouldBlock => Ok(true),
        Err(e) => Err(e),
    }
}

pub(super) fn mark_stop(paths: &Paths) -> Result<(), String> {
    lock_file(paths, STOP)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn stopping(paths: &Paths) -> bool {
    paths.root.join(STOP).exists()
}

pub(super) fn start(paths: &Paths) -> i32 {
    match start_owned(paths) {
        Ok(value) => ok(value),
        Err(error) => fail("daemon_unreachable", &error.to_string(), EXIT_UNREACHABLE),
    }
}

fn start_owned(paths: &Paths) -> anyhow::Result<serde_json::Value> {
    let _launch = launch_lock(paths)?;
    let deadline = Instant::now() + START_TIMEOUT;
    let mut launched: Option<Child> = None;
    loop {
        let host_owned = lifecycle::instance_locked(paths)?;
        if host_owned {
            if let Some(endpoint) = read_endpoint(paths).filter(health) {
                let mut value = facts(paths);
                value["started"] = serde_json::json!(launched.is_some());
                value["alreadyRunning"] = serde_json::json!(launched.is_none());
                value["port"] = serde_json::json!(endpoint.port);
                return Ok(value);
            }
        }
        if !host_owned && launched.is_none() && !running(paths)? {
            lifecycle::reap_stale_runtime(paths)?;
            // Locate before detaching: missing native/component artifacts remain
            // an immediate actionable start error, not a background retry loop.
            crate::wasm::spawn_command().map_err(anyhow::Error::msg)?;
            let (out, err) = start_log(paths)?;
            let mut command = Command::new(std::env::current_exe()?);
            command.args(["daemon", "supervise"]);
            for key in genet_frontdoor::launch_env::SESSION_SCOPED {
                command.env_remove(key);
            }
            command.stdin(Stdio::null()).stdout(out).stderr(err);
            // SAFETY: only the async-signal-safe session syscalls run after fork.
            unsafe {
                command.pre_exec(genet_native::process_group::own_session);
            }
            launched = Some(command.spawn()?);
        }
        if let Some(child) = launched.as_mut() {
            if let Some(status) = child.try_wait()? {
                anyhow::bail!("daemon supervisor exited {status}; inspect cli-start.log");
            }
        }
        if Instant::now() >= deadline {
            mark_stop(paths).map_err(anyhow::Error::msg)?;
            anyhow::bail!(
                "the supervised daemon did not publish an endpoint within {}s; inspect cli-start.log",
                START_TIMEOUT.as_secs()
            );
        }
        std::thread::sleep(POLL);
    }
}

pub(super) fn stop(paths: &Paths) -> i32 {
    match stop_owned(paths) {
        Ok((stopped, forced)) => {
            ok(serde_json::json!({"stopped": stopped, "running": false, "forced": forced}))
        }
        Err(error) => fail("internal", &error, EXIT_FAILED),
    }
}

pub(super) fn stop_owned(paths: &Paths) -> Result<(bool, bool), String> {
    if !paths.root.is_dir() {
        return Ok((false, false));
    }
    let _launch = launch_lock(paths).map_err(|e| e.to_string())?;
    let supervised = running(paths).map_err(|e| e.to_string())?;
    let (stopped, forced) = if supervised && read_endpoint(paths).is_none() {
        // A replacement may hold daemon.lock before it publishes an endpoint.
        // Address its owning supervisor, never an unproven PID from a file.
        mark_stop(paths)?;
        (true, false)
    } else if lifecycle::instance_locked(paths).map_err(|e| e.to_string())? {
        // stop_verified sets the stop flag only AFTER identity is established.
        // A foreign or silent listener must not cancel the real owner's recovery.
        (true, stop_verified(paths)?)
    } else if supervised {
        // The Host can be between crash and recovery, with no endpoint at all.
        mark_stop(paths)?;
        (true, false)
    } else {
        return Ok((false, false));
    };
    let deadline = Instant::now() + Duration::from_secs(15);
    while running(paths).map_err(|e| e.to_string())? {
        if Instant::now() >= deadline {
            return Err(
                "daemon supervisor has not confirmed descendant cleanup; inspect cli-start.log"
                    .into(),
            );
        }
        std::thread::sleep(POLL);
    }
    Ok((stopped, forced))
}

pub(super) fn run() -> i32 {
    match supervise() {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("daemon supervisor: {error:#}");
            EXIT_FAILED
        }
    }
}

fn supervise() -> anyhow::Result<()> {
    let paths = paths();
    paths.ensure()?;
    let lease = lock_file(&paths, LOCK)?;
    lease.try_lock_exclusive()?;
    // SAFETY: process-level child adoption flag; no pointer argument or memory.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } == -1 {
        return Err(io::Error::last_os_error().into());
    }
    match std::fs::remove_file(paths.root.join(STOP)) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut failures = 0u32;
    loop {
        if stopping(&paths) {
            return Ok(());
        }
        let mut command = crate::wasm::spawn_command().map_err(anyhow::Error::msg)?;
        // Preserve the public Host PID/SID contract and avoid sharing the
        // supervisor's group with anything the guest may terminate.
        unsafe {
            command.pre_exec(genet_native::process_group::own_session);
        }
        command.stdin(Stdio::null());
        let began = Instant::now();
        let mut child = command.spawn()?;
        eprintln!("daemon supervisor: started Host pid={}", child.id());
        let mut stop_at = None;
        let mut reaped = 0;
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            reaped += reap_completed_adoptees(child.id())?;
            if stopping(&paths) {
                if stop_at.is_none() {
                    // We own this unreaped Child, so its PID cannot be reused.
                    unsafe {
                        libc::kill(child.id() as i32, libc::SIGTERM);
                    }
                    stop_at = Some(Instant::now());
                } else if stop_at.is_some_and(|at: Instant| at.elapsed() >= STOP_TIMEOUT) {
                    child.kill()?;
                }
            }
            std::thread::sleep(POLL);
        };
        reaped += clean_descendants()?;
        eprintln!("daemon supervisor: Host exited {status}; descendants reaped={reaped}");
        if stopping(&paths) || status.success() {
            return Ok(());
        }
        if began.elapsed() >= Duration::from_secs(30) {
            failures = 0;
        }
        failures += 1;
        if failures >= 5 {
            anyhow::bail!(
                "five consecutive short Host failures; automatic recovery stopped; inspect cli-start.log"
            );
        }
        let delay = Duration::from_secs(1 << (failures - 1));
        let retry_at = Instant::now() + delay;
        eprintln!("daemon supervisor: recovering after {}s", delay.as_secs());
        while Instant::now() < retry_at {
            if stopping(&paths) {
                return Ok(());
            }
            std::thread::sleep(POLL);
        }
    }
}

/// Reap adopted orphans during normal operation, without consuming the Host's
/// exit status owned by std::process::Child. WNOWAIT leaves that status intact
/// if the Host exits between try_wait and this probe. Bound work per poll so
/// a stream of short-lived processes cannot starve stop handling.
fn reap_completed_adoptees(host: u32) -> io::Result<usize> {
    let mut reaped = 0;
    for _ in 0..64 {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_ALL,
                0,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if result == -1 {
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EINTR) => continue,
                Some(libc::ECHILD) => return Ok(reaped),
                _ => return Err(error),
            }
        }
        let pid = unsafe { info.si_pid() };
        if pid == 0 || pid as u32 == host {
            return Ok(reaped);
        }
        let result = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
        if result > 0 {
            reaped += 1;
        } else if result < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::EINTR) {
                return Err(error);
            }
        }
    }
    Ok(reaped)
}

/// An Agent may intentionally launch another independent manual daemon. Its
/// supervisor's kernel-held lifecycle lease is the ownership handoff, even
/// when this subreaper later adopts it. Merely naming a process is not proof.
fn delegated_supervisor(pid: i32) -> anyhow::Result<bool> {
    let proc = std::path::PathBuf::from(format!("/proc/{pid}"));
    let descriptors = match std::fs::read_dir(proc.join("fd")) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    for descriptor in descriptors {
        let descriptor = descriptor?;
        if std::fs::read_link(descriptor.path())
            .ok()
            .is_none_or(|target| target.file_name() != Some(std::ffi::OsStr::new(LOCK)))
        {
            continue;
        }
        let info = match std::fs::read_to_string(proc.join("fdinfo").join(descriptor.file_name())) {
            Ok(info) => info,
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        if info.lines().any(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            fields.len() == 9
                && fields[0] == "lock:"
                && fields[2..5] == ["FLOCK", "ADVISORY", "WRITE"]
                && fields[5].parse::<i32>() == Ok(pid)
                && fields[7..] == ["0", "EOF"]
        }) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Only direct children of this subreaper are signalled. Exiting parents make
/// their remaining descendants our children, even after double fork/setsid.
/// No waitpid runs between reading this list and signalling it, so an exited
/// child's PID remains reserved as our zombie and cannot name a stranger.
fn clean_descendants() -> anyhow::Result<usize> {
    let began = Instant::now();
    let mut reaped = 0;
    loop {
        loop {
            let result = unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
            if result > 0 {
                reaped += 1;
                continue;
            }
            if result < 0 {
                let error = io::Error::last_os_error();
                match error.raw_os_error() {
                    Some(libc::EINTR) => continue,
                    Some(libc::ECHILD) => {}
                    _ => return Err(error.into()),
                }
            }
            break;
        }
        let children =
            std::fs::read_to_string(format!("/proc/self/task/{}/children", std::process::id()))?;
        let children: Vec<i32> = children
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()?;
        let mut owned = Vec::new();
        for pid in children {
            if !delegated_supervisor(pid)? {
                owned.push(pid);
            }
        }
        if owned.is_empty() {
            return Ok(reaped);
        }
        if began.elapsed() >= Duration::from_secs(8) {
            anyhow::bail!(
                "owned descendants have not exited after TERM/KILL; refusing to overlap another Host"
            );
        }
        let signal = if began.elapsed() < Duration::from_secs(2) {
            libc::SIGTERM
        } else {
            libc::SIGKILL
        };
        for pid in owned {
            if unsafe { libc::kill(pid, signal) } == -1
                && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            {
                return Err(io::Error::last_os_error().into());
            }
        }
        std::thread::sleep(POLL);
    }
}
