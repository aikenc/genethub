//! The desktop shell's one real responsibility: keep a daemon running.
//!
//! Unit tests on the parser cannot catch the things that actually break here —
//! a binary that never prints, a shutdown that leaves the process behind, a
//! second start that spawns a duplicate. Those need the real binary.

use std::path::{Path, PathBuf};

use genethub_desktop_lib::daemon::Daemon;

fn daemon_binary() -> Option<PathBuf> {
    // The desktop crate is outside the workspace, so the daemon lands in the
    // workspace's own target directory rather than this crate's.
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let candidate = repo.join("target/debug/genet-daemon");
    candidate.exists().then_some(candidate)
}

macro_rules! with_daemon {
    ($binary:ident) => {
        let Some($binary) = daemon_binary() else {
            eprintln!("skipping: run cargo build -p genet-daemon first");
            return;
        };
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
        "clients need the token to connect"
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
fn stopping_leaves_nothing_behind_that_would_block_the_next_start() {
    with_daemon!(binary);
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(binary.clone(), dir.path().to_path_buf());

    let first = daemon.start().expect("first start");
    daemon.stop();

    // The daemon refuses to start twice on one data directory, so a restart
    // succeeding is proof the lock and the endpoint file were cleaned up.
    let restarted = Daemon::new(binary, dir.path().to_path_buf());
    let second = restarted.start().expect("a restart should not be blocked");
    assert_ne!(second.port, 0);
    let _ = first;
    restarted.stop();
}

#[test]
fn a_binary_that_is_not_there_fails_with_something_a_user_can_act_on() {
    let dir = tempfile::tempdir().unwrap();
    let daemon = Daemon::new(
        PathBuf::from("/nonexistent/genet-daemon"),
        dir.path().into(),
    );
    let error = daemon.start().expect_err("this cannot succeed");
    assert!(error.contains("daemon"), "unhelpful message: {error}");
    assert!(!daemon.is_running());
}
