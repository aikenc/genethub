//! The desktop shell's one real responsibility: keep a daemon running.
//!
//! Unit tests on the parser cannot catch the things that actually break here —
//! a binary that never prints, a shutdown that leaves the process behind, a
//! second start that spawns a duplicate. Those need the real binary.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

use genethub_desktop_lib::daemon::{Daemon, Origin, Watch};

fn daemon_binary() -> PathBuf {
    // The desktop crate is outside the workspace, so the daemon lands in the
    // workspace's own target directory rather than this crate's.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    // The stamp decides what the binary is called (`genet` in a release,
    // `genet-dev` in the tree) — read it from the daemon's channel constants
    // rather than pinning one channel's name here.
    let channel = std::fs::read_to_string(repo.join("apps/daemon/src/channel.rs"))
        .expect("the daemon channel constants must be readable");
    let name = channel
        .lines()
        .find_map(|line| line.strip_prefix("pub const CLI_BINARY: &str = "))
        .expect("CLI_BINARY must be declared in the daemon channel constants")
        .trim()
        .trim_matches(|c| c == '"' || c == ';');
    let candidate = repo.join(format!(
        "target/debug/{name}{}",
        std::env::consts::EXE_SUFFIX
    ));
    assert!(
        candidate.is_file(),
        "{} is missing; run cargo build -p genet-cli before the supervision tests",
        candidate.display()
    );
    candidate
}

/// Polls until `look` finds something, or gives up.
#[cfg(unix)]
fn wait_for<T>(limit: Duration, mut look: impl FnMut() -> Option<T>) -> Option<T> {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if let Some(found) = look() {
            return Some(found);
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    None
}

/// Kills the process *listening* on a port, without going through the shell's
/// own bookkeeping — the point is to simulate a crash it did not see coming.
///
/// Only the listener, and that distinction is not pedantic: the ports here are
/// handed out by the OS from the ephemeral range, so a completely unrelated
/// process can hold an outgoing connection whose local port is this one. Tools
/// that answer "who is using this port" include those, and killing them means
/// one test occasionally shooting another one's daemon.
#[cfg(unix)]
fn kill_whatever_is_listening_on(port: u16) {
    for pid in listeners_on(port) {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid])
            .status();
    }
}

#[cfg(unix)]
fn listeners_on(port: u16) -> Vec<String> {
    // `ss` prints one row per listening socket, with `pid=NNN` in the last
    // column: `LISTEN 0 511 127.0.0.1:41519 0.0.0.0:* users:(("x",pid=7,fd=9))`
    if let Ok(output) = std::process::Command::new("ss")
        .args(["-H", "-ltnp", "sport", "=", &format!(":{port}")])
        .output()
    {
        let listing = String::from_utf8_lossy(&output.stdout);
        let pids: Vec<String> = listing
            .split("pid=")
            .skip(1)
            .filter_map(|rest| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                (!digits.is_empty()).then_some(digits)
            })
            .collect();
        if !pids.is_empty() {
            return pids;
        }
    }

    std::process::Command::new("lsof")
        .args(["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"])
        .output()
        .map(|output| {
            String::from_utf8_lossy(&output.stdout)
                .split_whitespace()
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Keeps the daemon's default working folder out of whoever's home is running
/// the suite. Every test in this binary shares one, and none of them look in
/// it — they only need it to not be `~/GeneHub`.
fn contain_the_default_workspace() {
    static HOME: std::sync::OnceLock<tempfile::TempDir> = std::sync::OnceLock::new();
    let home = HOME.get_or_init(|| tempfile::tempdir().expect("a temporary home"));
    std::env::set_var("GENEHUB_WORKSPACE_DIR", home.path().join("GeneHub"));
}

macro_rules! with_daemon {
    ($binary:ident) => {
        let $binary = daemon_binary();
        contain_the_default_workspace();
    };
}

#[test]
fn starting_waits_until_the_daemon_says_where_it_is_listening() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(binary, dir.path().to_path_buf());

    let endpoint = daemon.start().expect("the daemon should start");
    assert!(endpoint.port > 0);
    assert!(
        !endpoint.token.is_empty(),
        "the shell needs the private key to supervise the exact daemon"
    );
    assert!(daemon.is_running());

    // The port is live, not just printed.
    let reachable = std::net::TcpStream::connect(("127.0.0.1", endpoint.port));
    assert!(
        reachable.is_ok(),
        "nothing is listening on the reported port"
    );

    daemon.stop();
    assert!(!daemon.is_running());
}

#[test]
fn a_second_start_returns_the_running_daemon_instead_of_spawning_another() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(binary, dir.path().to_path_buf());

    let first = daemon.start().expect("first start");
    let second = daemon.start().expect("second start");
    assert_eq!(
        first.port, second.port,
        "two daemons on one data directory would fight over the session files"
    );

    daemon.stop();
}

#[test]
fn stopping_releases_the_kernel_lock_and_allows_the_next_start() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(binary.clone(), dir.path().to_path_buf());

    let first = daemon.start().expect("first start");
    daemon.stop();

    // The endpoint is removed by the daemon on its way out, so its absence is
    // proof it was asked to stop and did, rather than being killed mid-session
    // with agents still running.
    assert!(
        !dir.path().join("endpoint.json").exists(),
        "a killed daemon would have left this behind"
    );
    // The lock pathname deliberately keeps one stable inode for the lifetime
    // of the data directory. Removing it after unlock would let racing starts
    // lock different inodes and both become the daemon.
    assert!(
        dir.path().join("daemon.lock").is_file(),
        "the stable lock inode must survive shutdown"
    );

    // The daemon refuses to start twice on one data directory, so a restart
    // succeeding is proof the kernel lock was released even though its stable
    // pathname remains.
    let restarted = Daemon::new(binary, dir.path().to_path_buf());
    let second = restarted.start().expect("a restart should not be blocked");
    assert_ne!(second.port, 0);
    let _ = first;
    restarted.stop();
}

/// The case a crashed shell leaves behind.
///
/// Before adoption the next launch spawned a second daemon, which lost the lock
/// race and exited without printing anything — so the shell waited twenty
/// seconds and told the user there was no machine, while their machine was
/// running the whole time.
#[test]
fn a_daemon_left_over_from_a_crashed_shell_is_adopted_rather_than_duplicated() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();

    let survivor = Daemon::new(binary.clone(), dir.path().to_path_buf());
    let running = survivor.start().expect("the first daemon starts");
    assert_eq!(survivor.origin(), Some(Origin::Spawned));

    // A new shell, with no memory of the process: exactly what a restart after
    // a crash looks like.
    let next = Daemon::new(binary, dir.path().to_path_buf());
    let adopted = next.start().expect("the second shell finds the daemon");

    assert_eq!(
        adopted.port, running.port,
        "it should have connected to the daemon that was already there"
    );
    assert_eq!(adopted.token, running.token);
    assert_eq!(next.origin(), Some(Origin::Adopted));
    assert!(next.is_running());

    // And it can end a daemon it never spawned, or quitting would leave one.
    next.stop();
    assert!(!next.is_running());
    assert!(!survivor.is_running());
}

/// A daemon killed outright, the way a crash or an OOM would do it.
#[cfg(unix)]
#[test]
fn the_watchdog_brings_the_daemon_back_and_says_where_it_went() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Arc::new(Daemon::new(binary, dir.path().to_path_buf()));
    let first = daemon.start().expect("the daemon starts");

    let restarts = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&restarts);
    daemon.watch(move |change| {
        if let Watch::Restarted(endpoint) = change {
            seen.lock().unwrap().push(endpoint);
        }
    });

    kill_whatever_is_listening_on(first.port);

    let restarted = wait_for(Duration::from_secs(30), || {
        restarts.lock().unwrap().first().cloned()
    })
    .expect("the watchdog should have restarted the daemon");

    assert_ne!(
        restarted.port, first.port,
        "a fresh listener means a fresh port, which is why the UI has to be told"
    );
    assert!(daemon.is_running());
    daemon.stop();
}

/// Quitting has to stop the watchdog too, or the daemon comes straight back.
#[test]
fn stopping_on_purpose_is_not_treated_as_a_crash() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Arc::new(Daemon::new(binary, dir.path().to_path_buf()));
    daemon.start().expect("the daemon starts");

    let restarts = Arc::new(Mutex::new(0usize));
    let seen = Arc::clone(&restarts);
    daemon.watch(move |change| {
        if matches!(change, Watch::Restarted(_)) {
            *seen.lock().unwrap() += 1;
        }
    });

    daemon.stop();
    std::thread::sleep(Duration::from_secs(4));

    assert_eq!(*restarts.lock().unwrap(), 0, "the user asked it to stop");
    assert!(!daemon.is_running());
}

#[test]
fn a_binary_that_is_not_there_fails_with_something_a_user_can_act_on() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(PathBuf::from("/nonexistent/genet"), dir.path().into());
    let error = daemon.start().expect_err("this cannot succeed");
    assert!(error.contains("daemon"), "unhelpful message: {error}");
    assert!(!daemon.is_running());
}
