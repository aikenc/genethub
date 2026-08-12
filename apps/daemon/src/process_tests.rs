use super::*;

/// The property the whole module exists for, and the one that a naive
/// implementation quietly fails: what the command started must stop too.
///
/// The workload is deliberately in a *grandchild*. A test whose work happens
/// in the process we spawn passes just as well when only that process is
/// killed, which is exactly the bug this guards.
#[cfg(unix)]
#[tokio::test]
async fn stopping_a_command_stops_what_the_command_started() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let marker = directory.path().join("alive.txt");
    let script = format!(
        "(while true; do echo alive >> {}; sleep 0.05; done) & sleep 30",
        marker.display()
    );

    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = command(&argv, &["-c".to_string(), script], directory.path());
    let group = Group::spawn(&mut command).expect("the shell starts");

    // Long enough that the grandchild is certainly writing.
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let while_running = std::fs::read_to_string(&marker).unwrap_or_default();
    assert!(
        !while_running.is_empty(),
        "the grandchild never started, so nothing was proven about stopping it"
    );

    drop(group);

    // The kill and the last write can cross; measure from after the dust
    // settles, not from the moment of the kill.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let settled = std::fs::read_to_string(&marker).unwrap_or_default();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let later = std::fs::read_to_string(&marker).unwrap_or_default();
    assert_eq!(
        settled.len(),
        later.len(),
        "the grandchild kept running after the command was stopped"
    );
}

/// A command that outlives its output pipe is the mirror image of the same
/// mistake: the process this daemon spawned has exited and its status is
/// available, and only a descendant is still holding the pipe open.
#[cfg(unix)]
#[tokio::test]
async fn a_command_is_over_when_it_exits_not_when_its_pipe_closes() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = command(
        &argv,
        // The `sleep` inherits stdout and keeps it open long after `sh` is
        // gone; reading to end-of-file first would wait for the sleep.
        &["-c".to_string(), "sleep 30 & exit 7".to_string()],
        directory.path(),
    );
    command.stdout(std::process::Stdio::piped());
    let mut group = Group::spawn(&mut command).expect("the shell starts");

    let status = tokio::time::timeout(std::time::Duration::from_secs(5), group.wait())
        .await
        .expect("waiting for the command must not wait for its descendants")
        .expect("the command is waited for");
    assert_eq!(status.code(), Some(7));
}

/// The way out, for the one case that means it.
///
/// Stopping the group is the right default precisely because it is what the
/// caller almost always meant, but a deploy script whose job is to leave a
/// service running behind it did mean the other thing. `setsid` is how a
/// process has always said so: it leaves the group, and leaving the group is
/// what puts it out of reach. Nothing else counts — `nohup` only declines a
/// hangup and stays in the group, so `nohup` does not survive this.
#[cfg(unix)]
#[tokio::test]
async fn a_process_that_leaves_the_group_on_purpose_is_left_alone() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let marker = directory.path().join("detached.txt");
    let script = format!(
        "setsid sh -c 'while true; do echo alive >> {}; sleep 0.05; done' & sleep 30",
        marker.display()
    );

    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = command(&argv, &["-c".to_string(), script], directory.path());
    let group = Group::spawn(&mut command).expect("the shell starts");
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert!(
        marker.exists(),
        "the detached process never started, so nothing was proven about sparing it"
    );

    drop(group);

    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let settled = std::fs::read_to_string(&marker).unwrap_or_default();
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let later = std::fs::read_to_string(&marker).unwrap_or_default();
    // Clean up before asserting: this one is meant to survive, and a failure
    // here must not leave it surviving on the machine running the tests.
    let _ = std::process::Command::new("pkill")
        .arg("-f")
        .arg(marker.display().to_string())
        .status();
    assert!(
        later.len() > settled.len(),
        "a process that detached into its own session was stopped anyway"
    );
}

/// The difference between asking and making, from the stopped process's point
/// of view.
///
/// A server killed outright leaves its socket file, its pidfile and its own
/// children behind, because none of its cleanup ever runs. The only way to
/// show that cleanup *did* run is to have the process write something from
/// inside its `SIGTERM` handler, which is what this does.
#[cfg(unix)]
#[tokio::test]
async fn a_process_asked_to_finish_gets_to_clean_up_after_itself() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let marker = directory.path().join("cleaned-up.txt");
    let script = format!(
        "trap 'echo tidy > {}; exit 0' TERM; while true; do sleep 0.05; done",
        marker.display()
    );

    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = command(&argv, &["-c".to_string(), script], directory.path());
    let mut group = Group::spawn(&mut command).expect("the shell starts");
    // The trap has to be installed before the signal arrives, or this would
    // pass by killing a process that had no handler yet.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let started = std::time::Instant::now();
    group.end().await;

    assert_eq!(
        std::fs::read_to_string(&marker).unwrap_or_default().trim(),
        "tidy",
        "the process was killed outright instead of being asked to finish"
    );
    // Honouring the request must not cost the grace period; only ignoring it
    // does.
    assert!(
        started.elapsed() < GRACE,
        "a process that finished promptly was still waited out"
    );
}

/// The other half: asking is not a way to be ignored.
#[cfg(unix)]
#[tokio::test]
async fn a_process_that_refuses_to_finish_is_stopped_anyway() {
    let directory = tempfile::tempdir().expect("a temporary directory");
    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    let mut command = command(
        &argv,
        &[
            "-c".to_string(),
            "trap '' TERM; while true; do sleep 0.05; done".to_string(),
        ],
        directory.path(),
    );
    let mut group = Group::spawn(&mut command).expect("the shell starts");
    let pid = group.pid().expect("a running command has a pid");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    tokio::time::timeout(GRACE * 3, group.end())
        .await
        .expect("a process that ignores the request must still be stopped");
    assert!(
        !tree_exists(pid),
        "the process survived being stopped after ignoring the request"
    );
}

#[test]
fn an_unconfined_launcher_is_just_the_program() {
    let argv = launch_argv("/bin/sh", None).expect("an unconfined launcher");
    assert_eq!(argv, vec![std::path::PathBuf::from("/bin/sh")]);
}
