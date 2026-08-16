//! What the operating system will hold a process to, when we start one for
//! somebody who is not sitting at this machine.
//!
//! The layer above this one decides *who* may ask (`authz.rs`). This one is
//! the only layer that can answer *what the process can actually touch*, and
//! it is the only one that is enforced by something other than our own code:
//! a shell we start can run `python -c` and walk straight past any list of
//! allowed command names we might have kept (`genet-remote-execution.md` §7.1).
//!
//! Three rules shape everything here.
//!
//! **It is detected, never assumed.** The kernel may have been built without
//! the mechanism we prefer, a container may have taken it away, and two of the
//! three platforms have no backend in this build yet. So the machine reports
//! what is actually in force, and a caller that needs confinement is refused
//! when it is not — never quietly given an unconfined process instead
//! (`genet-remote-execution.md` §7.5). "I thought I was in a sandbox" is far
//! more dangerous than "I know I am not".
//!
//! **A version floor is a bug, not a requirement.** Landlock is the better
//! mechanism and it arrived in linux 5.13; a large share of the machines
//! people leave running and reach into are older than that, which is precisely
//! the population this feature exists for. So Linux has two backends and the
//! older one needs nothing newer than 2013: build a filesystem view containing
//! only what the policy allows, and move the process into it. Landlock is
//! preferred where it exists because it restricts paths without changing what
//! they are; the namespace backend has to rebuild a root to reach the same
//! guarantee.
//!
//! **The restriction is applied by the process being restricted.** Both
//! backends act on the calling process and neither can be lifted afterwards.
//! Our pty layer spawns through `portable_pty`, which offers no hook between
//! fork and exec, so a confined process is started by re-running this binary as
//! [`CONFINE_ARG`]: it restricts itself, then execs what was asked for. If it
//! cannot restrict itself, it exits instead of exec'ing — the failure mode is a
//! terminal that will not open, not one that opens with nothing holding it
//! back. That wrapper must reach us before any thread starts: a multi-threaded
//! process cannot create a user namespace at all.

// OS confinement is the one system driver that must call kernel interfaces
// which Rust cannot make safe for us. Keep that exception local to this module;
// the rest of daemon-system remains under the crate-level unsafe-code deny.
#![allow(unsafe_code)]

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Result};
use genehub_proto::{IsolationBackend, IsolationInfo};

/// The hidden argv entry that turns this binary into the confining wrapper.
pub const CONFINE_ARG: &str = "__confine";

/// Overrides the binary used as the wrapper. Set by tests, which run inside a
/// harness binary that knows nothing about [`CONFINE_ARG`].
pub const CONFINE_COMMAND_ENV: &str = "GENEHUB_CONFINE_COMMAND";

/// The directories a confined process may reach, and how.
///
/// Everything not named here is denied, which is why the read-only set has to
/// include the parts of the system a program needs merely to start: the loader
/// and the shared libraries it maps are opened before `main` runs, and a shell
/// that cannot read `/usr/lib` dies before it can say why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Policy {
    /// The directories the request was about, and the only part of the policy
    /// anyone is told about. Kept apart from the rest of `writable` because
    /// "`/dev/null` is reachable" is true and useless: a caller trying to work
    /// out why a path is missing needs the workspace, not the plumbing.
    pub roots: Vec<PathBuf>,
    /// Writable, and not worth reporting: what a program needs merely to have
    /// a working stdio.
    pub writable: Vec<PathBuf>,
    pub readable: Vec<PathBuf>,
}

impl Policy {
    /// Everything the process may write, roots included.
    pub fn writable_paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.roots.iter().chain(self.writable.iter())
    }

    /// Confines a process to the workspace it was opened in.
    ///
    /// The workspace folders are writable because that is the work; the system
    /// is readable because that is the toolchain; nothing else is either. A
    /// path that does not exist on this machine is dropped rather than
    /// refused — the set below is the union of several distributions, and
    /// naming a missing one is not an error.
    pub fn for_workspace(roots: &[PathBuf]) -> Policy {
        // No `/proc`. It is the same account, so a confined process could read
        // `/proc/<daemon>/environ` and walk out with every provider key this
        // machine holds — a confinement that leaks the credentials is worse
        // than none, because it was trusted. Tools that need it will have to
        // ask for something narrower than the whole procfs.
        const SYSTEM: [&str; 7] = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/opt"];
        // A terminal is a character device and the shell talks to it; a great
        // many programs also expect the three that have always been there.
        const DEVICES: [&str; 5] = [
            "/dev/pts",
            "/dev/null",
            "/dev/zero",
            "/dev/tty",
            "/dev/full",
        ];
        Policy {
            roots: roots.iter().filter(|path| path.exists()).cloned().collect(),
            writable: DEVICES
                .iter()
                .map(PathBuf::from)
                .filter(|path| path.exists())
                .collect(),
            readable: SYSTEM
                .iter()
                .map(PathBuf::from)
                .filter(|path| path.exists())
                .collect(),
        }
    }

    /// The wrapper invocation that runs `program` under this policy.
    pub fn wrap(&self, program: &Path) -> Result<Vec<PathBuf>> {
        let helper = match std::env::var_os(CONFINE_COMMAND_ENV) {
            Some(path) => PathBuf::from(path),
            None => std::env::current_exe()?,
        };
        let mut argv = vec![helper, PathBuf::from(CONFINE_ARG)];
        // Named apart from `--rw` all the way through, so the wrapper can tell
        // the process what its workspace is without listing the device nodes.
        for path in &self.roots {
            argv.push(PathBuf::from("--root"));
            argv.push(path.clone());
        }
        for path in &self.writable {
            argv.push(PathBuf::from("--rw"));
            argv.push(path.clone());
        }
        for path in &self.readable {
            argv.push(PathBuf::from("--ro"));
            argv.push(path.clone());
        }
        argv.push(PathBuf::from("--"));
        argv.push(program.to_path_buf());
        Ok(argv)
    }
}

/// How a policy is described to the caller that caused it.
pub fn describe(policy: Option<&Policy>) -> Option<genehub_proto::Confinement> {
    policy.map(|policy| genehub_proto::Confinement {
        backend: report().backend,
        roots: policy
            .roots
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    })
}

/// What this machine can enforce, asked once and answered the same way every
/// time so that two callers never get two different stories.
pub fn report() -> IsolationInfo {
    static REPORT: std::sync::OnceLock<IsolationInfo> = std::sync::OnceLock::new();
    REPORT.get_or_init(probe).clone()
}

#[cfg(target_os = "linux")]
fn probe() -> IsolationInfo {
    // Landlock first where it exists: it restricts paths without changing what
    // they are, so a confined process sees the same filesystem everyone else
    // describes. The namespace backend has to rebuild a root to do the same
    // job, which is more moving parts for the same guarantee.
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
/// The library deliberately offers no runtime ABI lookup — it wants the
/// feature set fixed at build time and degraded on the way down — so this asks
/// the kernel directly. A version query creates nothing and restricts nobody.
#[cfg(target_os = "linux")]
fn landlock_abi() -> Result<i64, String> {
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

#[cfg(not(target_os = "linux"))]
fn probe() -> IsolationInfo {
    // Both of these have an unprivileged self-sandbox that would fit here —
    // Seatbelt on macOS, AppContainer on Windows (`genet-remote-execution.md`
    // §7.4). Neither is wired up in this build, and saying so is the whole
    // point: the report is what is in force, not what is planned.
    IsolationInfo {
        backend: IsolationBackend::None,
        enforced: false,
        detail: format!(
            "no isolation backend is implemented for {} in this build",
            std::env::consts::OS
        ),
    }
}

/// Restricts *this* process to `policy`, permanently.
///
/// Called between fork and exec, in the child, by the wrapper below.
#[cfg(target_os = "linux")]
pub fn confine(policy: &Policy) -> Result<String> {
    match report().backend {
        IsolationBackend::Landlock => landlock_confine(policy),
        IsolationBackend::Namespaces => namespace_confine(policy),
        other => Err(anyhow!("{other:?} cannot confine anything on this machine")),
    }
}

#[cfg(target_os = "linux")]
fn landlock_confine(policy: &Policy) -> Result<String> {
    use landlock::{
        Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, RulesetStatus, ABI,
    };

    // Fixed at build time on purpose, and deliberately not the newest: ABI 5
    // brought device ioctls under Landlock, and a shell that cannot issue
    // TCGETS on its own terminal is a shell that appears to hang. ABI 3 is the
    // last one that is purely about paths, and the library degrades it for
    // older kernels.
    const TARGET: ABI = ABI::V3;

    let status = Ruleset::default()
        .handle_access(AccessFs::from_all(TARGET))?
        .create()?
        .add_rules(landlock::path_beneath_rules(
            policy.writable_paths(),
            AccessFs::from_all(TARGET),
        ))?
        .add_rules(landlock::path_beneath_rules(
            &policy.readable,
            AccessFs::from_read(TARGET),
        ))?
        .restrict_self()?;

    match status.ruleset {
        // Some of what we asked for was not available on this kernel, but the
        // paths are the part that matters and they are in force. Reported, not
        // hidden, so a surprise shows up in a log rather than in an incident.
        RulesetStatus::FullyEnforced => Ok("landlock, fully enforced".to_string()),
        RulesetStatus::PartiallyEnforced => {
            Ok("landlock, partially enforced on this kernel".to_string())
        }
        RulesetStatus::NotEnforced => Err(anyhow!(
            "landlock accepted the ruleset without enforcing any of it"
        )),
    }
}

/// Confines by replacing what the filesystem *is*, for this process alone.
///
/// Where Landlock leaves the tree intact and refuses the parts a process may
/// not touch, this builds a new root holding only the allowed subtrees and
/// moves the process into it. Everything else is not forbidden — it is absent,
/// which is the stronger of the two answers and the only one available before
/// linux 5.13.
///
/// Each allowed directory is bound at *the same absolute path* it has outside.
/// A confined shell is meant to be a working shell: its cwd has to stay valid
/// and the paths it prints have to be the paths the person on the other end
/// typed.
///
/// The order below is load-bearing at one point in particular. After
/// `pivot_root` the old root is still mounted and still readable — a sandbox
/// with the whole filesystem hanging off a directory inside it. It is detached
/// with the raw syscall rather than the `umount` command because by then there
/// is no `/proc` for that command to read its mount table from.
#[cfg(target_os = "linux")]
fn namespace_confine(policy: &Policy) -> Result<String> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    fn cstr(path: &Path) -> Result<CString> {
        CString::new(path.as_os_str().as_bytes()).map_err(|_| anyhow!("a path contains a nul byte"))
    }
    fn check(what: &str, code: i32) -> Result<()> {
        if code == 0 {
            return Ok(());
        }
        Err(anyhow!("{what}: {}", std::io::Error::last_os_error()))
    }

    // Kept so the process can be put back where it started once the ground has
    // moved. An open cwd would otherwise point into the detached old root.
    let cwd = std::env::current_dir().ok();
    let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };

    check("creating a private namespace", unsafe {
        libc::unshare(libc::CLONE_NEWUSER | libc::CLONE_NEWNS)
    })?;

    // Identity mapping, not a map to root: the shell should be the same user it
    // would have been, holding the same ownership over the workspace files. The
    // capabilities needed for the mounts below come from having created the
    // namespace, not from the uid inside it. `setgroups` must be surrendered
    // before gid_map will be accepted.
    std::fs::write("/proc/self/setgroups", "deny").ok();
    std::fs::write("/proc/self/uid_map", format!("{uid} {uid} 1"))
        .map_err(|error| anyhow!("mapping this user into the namespace: {error}"))?;
    std::fs::write("/proc/self/gid_map", format!("{gid} {gid} 1"))
        .map_err(|error| anyhow!("mapping this group into the namespace: {error}"))?;

    let null = CString::new("")?;
    let none = std::ptr::null::<libc::c_void>();

    // Without this, every mount below propagates back out to the machine.
    check("detaching mount propagation", unsafe {
        libc::mount(
            null.as_ptr(),
            cstr(Path::new("/"))?.as_ptr(),
            std::ptr::null(),
            libc::MS_REC | libc::MS_PRIVATE,
            none,
        )
    })?;

    // One fixed staging point rather than a fresh temporary directory per
    // terminal: each confined process mounts over it inside its own namespace,
    // so they never see each other's, and the machine is left with a single
    // empty directory instead of a growing pile of them.
    let stage = std::env::temp_dir().join(".genet-confine");
    std::fs::create_dir_all(&stage)?;
    let stage_c = cstr(&stage)?;
    let tmpfs = CString::new("tmpfs")?;
    check("creating the confined root", unsafe {
        libc::mount(tmpfs.as_ptr(), stage_c.as_ptr(), tmpfs.as_ptr(), 0, none)
    })?;

    let mut bound = 0usize;
    for (source, writable) in policy
        .writable_paths()
        .map(|path| (path, true))
        .chain(policy.readable.iter().map(|path| (path, false)))
    {
        let Ok(relative) = source.strip_prefix("/") else {
            continue;
        };
        let target = stage.join(relative);
        // Mirroring a file (a device node, say) needs a file to mount onto.
        if source.is_dir() {
            std::fs::create_dir_all(&target)?;
        } else {
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::File::create(&target)?;
        }
        let (source_c, target_c) = (cstr(source)?, cstr(&target)?);
        check(&format!("mirroring {}", source.display()), unsafe {
            libc::mount(
                source_c.as_ptr(),
                target_c.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REC,
                none,
            )
        })?;
        if !writable {
            // A bind mount carries the source's flags; read-only has to be
            // asked for in a second call, and silently keeping a writable
            // mount would be the failure nobody notices.
            check(&format!("sealing {} read-only", source.display()), unsafe {
                libc::mount(
                    source_c.as_ptr(),
                    target_c.as_ptr(),
                    std::ptr::null(),
                    libc::MS_BIND | libc::MS_REMOUNT | libc::MS_RDONLY | libc::MS_REC,
                    none,
                )
            })?;
        }
        bound += 1;
    }

    let old = stage.join(".oldroot");
    std::fs::create_dir_all(&old)?;
    check("entering the confined root", unsafe {
        libc::syscall(libc::SYS_pivot_root, stage_c.as_ptr(), cstr(&old)?.as_ptr()) as i32
    })?;

    let root = cstr(Path::new("/"))?;
    check("standing in the new root", unsafe {
        libc::chdir(root.as_ptr())
    })?;
    // The whole point of the exercise. Everything above is undone if this line
    // does not run, so its failure is fatal rather than logged.
    check("detaching the old root", unsafe {
        libc::umount2(cstr(Path::new("/.oldroot"))?.as_ptr(), libc::MNT_DETACH)
    })?;
    std::fs::remove_dir("/.oldroot").ok();

    // Back to where the terminal was opened, now that the path means something
    // different. If it was outside the policy it no longer exists, and the root
    // of the confined view is the honest place to be.
    if let Some(cwd) = cwd.filter(|path| path.exists()) {
        let _ = std::env::set_current_dir(cwd);
    }

    Ok(format!(
        "namespaces, {bound} paths mirrored, old root detached"
    ))
}

#[cfg(not(target_os = "linux"))]
pub fn confine(_policy: &Policy) -> Result<String> {
    Err(anyhow!(
        "no isolation backend is implemented for {} in this build",
        std::env::consts::OS
    ))
}

/// Names the variables that tell a confined process it is one.
///
/// Nothing else can. From inside a namespace the rest of the filesystem is
/// simply gone, which is indistinguishable from a machine that never had it —
/// and an agent that reads "no such directory" will go and create it, or
/// decide the toolchain is broken and reinstall it. Under Landlock the same
/// policy produces "permission denied" instead, so even the symptom is not a
/// stable thing to learn. These are the only in-band way to tell the
/// difference, and they cost two `setenv` calls.
pub const CONFINED_BACKEND_ENV: &str = "GENEHUB_CONFINEMENT";
pub const CONFINED_ROOTS_ENV: &str = "GENEHUB_CONFINED_ROOTS";

fn announcement(backend: IsolationBackend, policy: &Policy) -> Vec<(String, String)> {
    vec![
        (
            CONFINED_BACKEND_ENV.to_string(),
            format!("{backend:?}").to_lowercase(),
        ),
        (CONFINED_ROOTS_ENV.to_string(), joined(&policy.roots)),
    ]
}

/// Path-list separator, as every Unix tool already writes one. A path holding
/// a colon would be mis-split, which is the same limitation `PATH` has had
/// throughout, and a worse trade than inventing a separator nobody parses.
fn joined(paths: &[PathBuf]) -> String {
    paths
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(":")
}

/// The wrapper: restrict this process, then become the program that was asked
/// for. Never returns on success, because there is nothing left of us to
/// return to.
pub fn confine_and_exec(args: &[String]) -> i32 {
    let mut policy = Policy {
        roots: Vec::new(),
        writable: Vec::new(),
        readable: Vec::new(),
    };
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--root" | "--rw" | "--ro" => {
                let Some(path) = args.get(index + 1) else {
                    eprintln!("genet: {} needs a path", args[index]);
                    return 2;
                };
                match args[index].as_str() {
                    "--root" => policy.roots.push(PathBuf::from(path)),
                    "--rw" => policy.writable.push(PathBuf::from(path)),
                    _ => policy.readable.push(PathBuf::from(path)),
                }
                index += 2;
            }
            "--" => {
                rest = args[index + 1..].to_vec();
                break;
            }
            other => {
                eprintln!("genet: {other} is not a confinement option");
                return 2;
            }
        }
    }
    let Some((program, arguments)) = rest.split_first() else {
        eprintln!("genet: nothing to run under confinement");
        return 2;
    };

    let backend = report().backend;
    if let Err(error) = confine(&policy) {
        // The one thing this process must never do is exec anyway.
        eprintln!("genet: refusing to start an unconfined process: {error}");
        return 70;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(program)
            .envs(announcement(backend, &policy))
            .args(arguments)
            .exec();
        // The one moment where saying "no such file" alone would be actively
        // misleading: from in here the rest of the filesystem is missing, and
        // a program that reads this is meant to conclude "out of bounds"
        // rather than "not installed".
        eprintln!(
            "genet: {program} could not be started: {error}. This process is confined to {}; \
             anything outside is {}.",
            joined(&policy.roots),
            match backend {
                IsolationBackend::Namespaces => "not there at all",
                _ => "refused",
            }
        );
        71
    }
    #[cfg(not(unix))]
    {
        let _ = arguments;
        eprintln!("genet: confinement is not available on this platform");
        70
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_machine_reports_the_same_thing_every_time_it_is_asked() {
        // Two callers deciding whether to run something they do not trust must
        // not be able to get two different answers.
        assert_eq!(report(), report());
    }

    #[test]
    fn nothing_is_claimed_that_is_not_implemented_here() {
        let report = report();
        if report.backend == IsolationBackend::None {
            assert!(!report.enforced, "no backend cannot be enforcing anything");
        }
        assert!(
            !report.detail.trim().is_empty(),
            "a report a person cannot act on is not a report"
        );
    }

    #[test]
    fn a_policy_names_the_workspace_and_the_toolchain_and_nothing_else() {
        let workspace = std::env::temp_dir();
        let policy = Policy::for_workspace(std::slice::from_ref(&workspace));
        assert!(policy.roots.contains(&workspace));
        assert!(
            !policy.writable_paths().any(|path| path == Path::new("/")),
            "a policy that allows the root allows everything"
        );
        assert!(!policy.readable.iter().any(|path| path == Path::new("/")));
        // Every path handed to the kernel has to exist, or the rule is dropped
        // on the floor and the result is a quieter policy than it looks.
        for path in policy.writable_paths().chain(policy.readable.iter()) {
            assert!(path.exists(), "{} does not exist", path.display());
        }
        // The daemon runs as this same account, so procfs would hand over its
        // environment — every provider key on the machine — to anything the
        // policy was supposed to be containing.
        assert!(
            !policy
                .readable
                .iter()
                .any(|path| path.starts_with("/proc") || path.starts_with("/sys")),
            "a confined process can read the daemon's own environment"
        );
    }

    /// A process that cannot tell confinement from a bare machine will act on
    /// the wrong one: create the directory it cannot see, reinstall the
    /// toolchain it cannot reach. What it is told has to be the workspace and
    /// only the workspace — `/dev/null` is reachable, and saying so helps
    /// nobody work out where their files went.
    #[test]
    fn a_confined_process_is_told_the_workspace_and_not_the_plumbing() {
        let policy = Policy {
            roots: vec![PathBuf::from("/tmp/a"), PathBuf::from("/tmp/b")],
            writable: vec![PathBuf::from("/dev/null")],
            readable: vec![PathBuf::from("/usr")],
        };
        let announced: std::collections::HashMap<_, _> =
            announcement(IsolationBackend::Namespaces, &policy)
                .into_iter()
                .collect();
        assert_eq!(
            announced[CONFINED_ROOTS_ENV], "/tmp/a:/tmp/b",
            "the caller cannot act on roots it was not given"
        );
        assert!(
            !announced[CONFINED_ROOTS_ENV].contains("/dev"),
            "the plumbing is not somewhere anyone's files went"
        );
        assert_eq!(
            announced[CONFINED_BACKEND_ENV], "namespaces",
            "which backend decides whether the symptom is absence or refusal"
        );
    }

    /// Not cosmetic: the two backends make the same policy look like two
    /// different faults, so a process that only sees the symptom cannot learn
    /// a rule that holds on the next machine.
    #[test]
    fn the_backend_is_named_because_the_symptom_differs_by_backend() {
        let policy = Policy {
            roots: vec![PathBuf::from("/tmp")],
            writable: Vec::new(),
            readable: Vec::new(),
        };
        let of = |backend| {
            announcement(backend, &policy)
                .into_iter()
                .collect::<std::collections::HashMap<_, _>>()[CONFINED_BACKEND_ENV]
                .clone()
        };
        assert_eq!(of(IsolationBackend::Landlock), "landlock");
        assert_ne!(
            of(IsolationBackend::Landlock),
            of(IsolationBackend::Namespaces)
        );
    }

    #[test]
    fn the_wrapper_puts_the_program_last_so_its_arguments_cannot_become_ours() {
        let policy = Policy {
            roots: vec![PathBuf::from("/tmp")],
            writable: vec![PathBuf::from("/dev/null")],
            readable: vec![PathBuf::from("/usr")],
        };
        std::env::set_var(CONFINE_COMMAND_ENV, "/opt/genet");
        let argv = policy
            .wrap(Path::new("/bin/sh"))
            .expect("a wrapped command");
        std::env::remove_var(CONFINE_COMMAND_ENV);
        assert_eq!(
            argv,
            [
                "/opt/genet",
                CONFINE_ARG,
                "--root",
                "/tmp",
                "--rw",
                "/dev/null",
                "--ro",
                "/usr",
                "--",
                "/bin/sh"
            ]
            .map(PathBuf::from)
        );
    }
}
