//! What the operating system will hold a process to, when we start one for
//! somebody who is not sitting at this machine.
//!
//! The layer above this one decides *who* may ask (`authz.rs`). This one is
//! the only layer that can answer *what the process can actually touch*, and
//! it is the only one that is enforced by something other than our own code:
//! a shell we start can run `python -c` and walk straight past any list of
//! allowed command names we might have kept (`genet-remote-execution.md` §7.1).
//!
//! Two rules shape everything here.
//!
//! **It is detected, never assumed.** The kernel may have been built without
//! Landlock, a container may have taken it away, and two of the three
//! platforms have no backend in this build yet. So the machine reports what is
//! actually in force, and a caller that needs confinement is refused when it
//! is not — never quietly given an unconfined process instead
//! (`genet-remote-execution.md` §7.5). "I thought I was in a sandbox" is far
//! more dangerous than "I know I am not".
//!
//! **The restriction is applied by the process being restricted.** Landlock
//! restricts the calling thread and is inherited across `execve`, and cannot
//! be lifted afterwards. Our pty layer spawns through `portable_pty`, which
//! offers no hook between fork and exec, so a confined process is started by
//! re-running this binary as [`CONFINE_ARG`]: it restricts itself, then execs
//! what was asked for. If it cannot restrict itself, it exits instead of
//! exec'ing — the failure mode is a terminal that will not open, not one that
//! opens with nothing holding it back.

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
    pub writable: Vec<PathBuf>,
    pub readable: Vec<PathBuf>,
}

impl Policy {
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
            writable: roots
                .iter()
                .cloned()
                .chain(DEVICES.iter().map(PathBuf::from))
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

/// What this machine can enforce, asked once and answered the same way every
/// time so that two callers never get two different stories.
pub fn report() -> IsolationInfo {
    static REPORT: std::sync::OnceLock<IsolationInfo> = std::sync::OnceLock::new();
    REPORT.get_or_init(probe).clone()
}

#[cfg(target_os = "linux")]
fn probe() -> IsolationInfo {
    // The library deliberately offers no runtime ABI lookup — it wants the
    // supported feature set decided at build time and degraded on the way down
    // — so the question "is there a Landlock here at all" is asked of the
    // kernel directly. A version query creates nothing and restricts nobody.
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    let abi = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    match abi {
        version if version >= 1 => IsolationInfo {
            backend: IsolationBackend::Landlock,
            enforced: true,
            detail: format!("landlock abi {version}"),
        },
        _ => {
            let reason = match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::ENOSYS) => "this kernel has no landlock; it arrived in linux 5.13",
                Some(libc::EOPNOTSUPP) => {
                    "landlock is built in but switched off; add it to the kernel's lsm= list"
                }
                _ => "landlock could not be queried",
            };
            IsolationInfo {
                backend: IsolationBackend::None,
                enforced: false,
                detail: reason.to_string(),
            }
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
            &policy.writable,
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

#[cfg(not(target_os = "linux"))]
pub fn confine(_policy: &Policy) -> Result<String> {
    Err(anyhow!(
        "no isolation backend is implemented for {} in this build",
        std::env::consts::OS
    ))
}

/// The wrapper: restrict this process, then become the program that was asked
/// for. Never returns on success, because there is nothing left of us to
/// return to.
pub fn confine_and_exec(args: &[String]) -> i32 {
    let mut policy = Policy {
        writable: Vec::new(),
        readable: Vec::new(),
    };
    let mut rest = Vec::new();
    let mut index = 0;
    while index < args.len() {
        match args[index].as_str() {
            "--rw" | "--ro" => {
                let Some(path) = args.get(index + 1) else {
                    eprintln!("genet: {} needs a path", args[index]);
                    return 2;
                };
                if args[index] == "--rw" {
                    policy.writable.push(PathBuf::from(path));
                } else {
                    policy.readable.push(PathBuf::from(path));
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

    if let Err(error) = confine(&policy) {
        // The one thing this process must never do is exec anyway.
        eprintln!("genet: refusing to start an unconfined process: {error}");
        return 70;
    }

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(program).args(arguments).exec();
        eprintln!("genet: {} could not be started: {error}", program);
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
        assert!(policy.writable.contains(&workspace));
        assert!(
            !policy.writable.iter().any(|path| path == Path::new("/")),
            "a policy that allows the root allows everything"
        );
        assert!(!policy.readable.iter().any(|path| path == Path::new("/")));
        // Every path handed to the kernel has to exist, or the rule is dropped
        // on the floor and the result is a quieter policy than it looks.
        for path in policy.writable.iter().chain(policy.readable.iter()) {
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

    #[test]
    fn the_wrapper_puts_the_program_last_so_its_arguments_cannot_become_ours() {
        let policy = Policy {
            writable: vec![PathBuf::from("/tmp")],
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
                "--rw",
                "/tmp",
                "--ro",
                "/usr",
                "--",
                "/bin/sh"
            ]
            .map(PathBuf::from)
        );
    }
}
