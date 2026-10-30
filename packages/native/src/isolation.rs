//! Kernel isolation capabilities for machine diagnostics.
//!
//! Complete Agent connections execute as the daemon OS user. This module
//! queries available kernel mechanisms; it never confines a process.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IsolationBackend {
    Landlock,
    /// Unprivileged user and mount namespaces: a filesystem view built to hold
    /// only what the caller is allowed to see. Older than Landlock by a
    /// decade, and the only thing available on a kernel that predates it.
    Namespaces,
    Seatbelt,
    AppContainer,
    None,
}

/// Kernel capability observation for machine diagnostics.
/// This does not describe restrictions applied to an Agent process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationInfo {
    pub backend: IsolationBackend,
    /// Whether the kernel capability probe succeeded. No Agent isolation is applied.
    pub enforced: bool,
    /// Why, in a sentence a person can act on. Present whether or not it worked,
    /// because "landlock, abi 4" is as worth saying as "kernel 5.4 has none".
    pub detail: String,
}

/// What this machine can enforce, asked once and answered the same way every
/// time so that two callers never get two different stories.
#[cfg(not(target_family = "wasm"))]
pub fn report() -> IsolationInfo {
    static REPORT: std::sync::OnceLock<IsolationInfo> = std::sync::OnceLock::new();
    REPORT.get_or_init(probe).clone()
}

#[cfg(target_os = "linux")]
fn probe() -> IsolationInfo {
    // Prefer the side-effect-free Landlock ABI query. If unavailable, probe
    // namespace support in a short-lived child; never restrict this process.
    match landlock_abi() {
        Ok(version) => IsolationInfo {
            backend: IsolationBackend::Landlock,
            enforced: true,
            detail: format!("landlock abi {version}"),
        },
        // Not an error yet. Landlock arrived in 5.13 and a great many machines
        // are older than that — including the ones people leave running and
        // reach into, which is exactly what this is for.
        Err(landlock) if namespaces_work() => IsolationInfo {
            backend: IsolationBackend::Namespaces,
            enforced: true,
            detail: format!("unprivileged user and mount namespaces ({landlock})"),
        },
        Err(landlock) => IsolationInfo {
            backend: IsolationBackend::None,
            enforced: false,
            detail: format!("{landlock}, and unprivileged user namespaces are unavailable too"),
        },
    }
}

/// The Landlock ABI this kernel speaks, or why it speaks none.
///
/// A direct version query creates nothing and restricts nobody.
#[cfg(target_os = "linux")]
fn landlock_abi() -> std::result::Result<i64, String> {
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    if abi >= 1 {
        return Ok(abi);
    }
    Err(match std::io::Error::last_os_error().raw_os_error() {
        Some(libc::ENOSYS) => "this kernel has no landlock; it arrived in linux 5.13".to_string(),
        Some(libc::EOPNOTSUPP) => {
            "landlock is built in but switched off; add it to the kernel's lsm= list".to_string()
        }
        _ => "landlock could not be queried".to_string(),
    })
}

/// Whether this process could build itself a private filesystem view.
///
/// Answered by trying, in a child that does nothing else and exits: the
/// sysctls that are supposed to describe this disagree between distributions,
/// containers change the answer, and a hardened kernel can refuse for reasons
/// no file will admit to. The child only makes syscalls that are safe to make
/// after a fork.
#[cfg(target_os = "linux")]
fn namespaces_work() -> bool {
    match unsafe { libc::fork() } {
        -1 => false,
        0 => {
            let made = unsafe { libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS) };
            unsafe { libc::_exit(if made == 0 { 0 } else { 1 }) }
        }
        child => {
            let mut status = 0;
            if unsafe { libc::waitpid(child, &mut status, 0) } < 0 {
                return false;
            }
            libc::WIFEXITED(status) && libc::WEXITSTATUS(status) == 0
        }
    }
}

#[cfg(all(not(target_os = "linux"), not(target_family = "wasm")))]
fn probe() -> IsolationInfo {
    // This diagnostic currently probes Linux kernel mechanisms only.
    IsolationInfo {
        backend: IsolationBackend::None,
        enforced: false,
        detail: format!(
            "kernel isolation capability is not probed for {} in this build",
            std::env::consts::OS
        ),
    }
}
