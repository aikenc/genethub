//! Unix process session and group ownership. Call only signal_group with an
//! owned group ID; signal_tree resolves an arbitrary live process without guessing.

/// Puts the child in a session of its own, so that what it starts has a name.
///
/// A fresh fork is never a process group leader, so this normally succeeds.
/// `EPERM` means it already is one, and then it is already the thing we were
/// trying to make it.
#[cfg(unix)]
pub fn own_session() -> std::io::Result<()> {
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

/// Whether there is still anything in the group. A group outlives its leader
/// as long as any member is running, which is exactly the thing being waited
/// out here.
#[cfg(unix)]
pub fn tree_exists(pid: u32) -> bool {
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
pub fn signal_tree(pid: u32, signal: libc::c_int) {
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    if group <= 0 {
        return;
    }
    signal_group(group as u32, signal);
}

/// Best effort throughout: every failure here means somebody else already did
/// it.
#[cfg(unix)]
pub fn signal_group(group: u32, signal: libc::c_int) {
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

/// The caller owns a leader PID and may have already reaped it.
pub fn signal_owned(pid: u32, signal: libc::c_int) {
    let group = unsafe { libc::getpgid(pid as libc::pid_t) };
    signal_group(if group > 0 { group as u32 } else { pid }, signal);
}
