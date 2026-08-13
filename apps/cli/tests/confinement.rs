//! The wrapper that puts a process inside an operating system sandbox.
//!
//! Run as a subprocess on purpose. Confinement is applied to the calling
//! process and cannot be undone — Landlock restricts the thread, the namespace
//! backend replaces the filesystem underneath it — so a test that applied it
//! in-process would confine the test runner and everything it went on to do.

use std::path::Path;
use std::process::Command;

use genet_daemon::isolation::{self, Policy, CONFINE_COMMAND_ENV};

fn genet() -> &'static str {
    env!("CARGO_BIN_EXE_genet-dev")
}

/// Runs a program through the wrapper, under a policy that allows `writable`.
///
/// The override is set once and never taken back. Libtest runs these in
/// parallel threads of one process, so a test that set the variable and then
/// removed it would be removing it out from under whichever test was mid-`wrap`
/// — which silently falls back to this test binary as the wrapper and fails
/// somewhere far from the cause.
fn confined(writable: &Path, program: &str, arguments: &[&str]) -> (String, String, i32) {
    static WRAPPER: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    WRAPPER.get_or_init(|| std::env::set_var(CONFINE_COMMAND_ENV, genet()));

    let argv = Policy::for_workspace(&[writable.to_path_buf()])
        .wrap(Path::new(program))
        .expect("a wrapped command");
    let (helper, rest) = argv.split_first().expect("a wrapper command");
    let output = Command::new(helper)
        .args(rest)
        .args(arguments)
        .output()
        .expect("the wrapper could not be run");
    (
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        output.status.code().unwrap_or(-1),
    )
}

#[test]
fn a_process_that_cannot_be_confined_is_never_started_instead() {
    // The failure that matters is not "the terminal did not open". It is "the
    // terminal opened and nothing was holding it", which nobody would notice.
    let inside = tempfile::tempdir().expect("a workspace");
    let (stdout, stderr, code) = confined(inside.path(), "/bin/echo", &["it ran"]);

    if isolation::report().enforced {
        assert_eq!(code, 0, "{stderr}");
        assert!(stdout.contains("it ran"), "{stdout}");
    } else {
        assert_ne!(
            code, 0,
            "an unconfinable machine started the process anyway"
        );
        assert!(
            !stdout.contains("it ran"),
            "the process ran despite the refusal: {stdout}"
        );
        assert!(
            stderr.contains("refusing to start an unconfined process"),
            "the refusal has to say what it refused and why: {stderr}"
        );
    }
}

#[test]
fn a_confined_process_reaches_its_workspace_and_nothing_beside_it() {
    let Some(()) = kernel_can_confine() else {
        return;
    };
    let inside = tempfile::tempdir().expect("a workspace");
    let outside = tempfile::tempdir().expect("somewhere else on the same machine");
    std::fs::write(inside.path().join("mine.txt"), "in the workspace").expect("a file to read");
    std::fs::write(outside.path().join("theirs.txt"), "not the workspace").expect("a file to read");

    let (stdout, stderr, code) = confined(
        inside.path(),
        "/bin/cat",
        &[&inside.path().join("mine.txt").to_string_lossy()],
    );
    assert_eq!(code, 0, "the workspace itself became unreadable: {stderr}");
    assert!(stdout.contains("in the workspace"));

    // Same process, same policy, a path one directory over. The workspace is
    // the boundary, and it is the kernel enforcing it rather than a list of
    // command names we happen to have thought of.
    let (stdout, _, code) = confined(
        inside.path(),
        "/bin/cat",
        &[&outside.path().join("theirs.txt").to_string_lossy()],
    );
    assert_ne!(code, 0, "a confined process read outside its workspace");
    assert!(!stdout.contains("not the workspace"), "{stdout}");
}

#[test]
fn a_confinement_that_rebuilds_the_root_leaves_no_way_back_to_the_old_one() {
    let Some(()) = kernel_can_confine() else {
        return;
    };
    // Specific to the namespace backend and worth its own test, because the
    // way it fails is silent. `pivot_root` leaves the entire previous
    // filesystem mounted inside the new one; until it is detached, every path
    // the policy excluded is still there under another name, and every other
    // assertion in this file would go on passing.
    let inside = tempfile::tempdir().expect("a workspace");
    let outside = tempfile::tempdir().expect("somewhere else on the same machine");
    std::fs::write(outside.path().join("theirs.txt"), "not the workspace").expect("a file to read");
    let hidden = outside.path().join("theirs.txt");

    let (stdout, _, _) = confined(
        inside.path(),
        "/bin/sh",
        &[
            "-c",
            &format!(
                "cat /.oldroot{0} /oldroot{0} /old{0} 2>&1; ls -a / 2>&1",
                hidden.display()
            ),
        ],
    );
    assert!(
        !stdout.contains("not the workspace"),
        "the previous root is still reachable from inside the sandbox: {stdout}"
    );
}

#[test]
fn the_wrapper_refuses_arguments_it_does_not_understand() {
    // It is spawned with argv built by us, so anything unrecognised means the
    // caller and the wrapper disagree about the policy — the one situation
    // where guessing would produce a sandbox nobody described.
    let output = Command::new(genet())
        .args(["__confine", "--allow-everything", "--", "/bin/echo", "hi"])
        .output()
        .expect("the wrapper could not be run");
    assert_eq!(output.status.code(), Some(2));
    assert!(!String::from_utf8_lossy(&output.stdout).contains("hi"));
}

/// Skips with a reason rather than passing quietly, because a green test that
/// proved nothing is worse than a loud gap.
fn kernel_can_confine() -> Option<()> {
    let report = isolation::report();
    if report.enforced {
        return Some(());
    }
    eprintln!(
        "skipping: this machine cannot confine a process ({}); the refusal path is covered by \
         the test above",
        report.detail
    );
    None
}
