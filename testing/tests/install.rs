//! `scripts/install.sh`, run for real.
//!
//! This is the only way onto a machine with no graphical session, and it is a
//! shell script — the kind of thing that breaks silently and is discovered by a
//! stranger. So it is run against a real release layout on disk: real `curl`,
//! real `tar`, real `sha256sum`, real target directory.
//!
//! The two properties worth pinning are the ones whose failure is expensive:
//! the binaries land runnable, and a download that does not match its checksum
//! is refused rather than installed.
//!
//! Unix only, which is also all the script claims to cover: Windows gets the
//! installer from `release.yml`.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Command, Output};

use tempfile::TempDir;

#[test]
fn installing_puts_both_binaries_where_the_path_can_find_them() {
    if skip() {
        return;
    }
    let release = fake_release();
    let home = TempDir::new().expect("temp home");
    let bin = home.path().join("bin");

    let output = install(release.path(), &bin);
    assert!(
        output.status.success(),
        "install failed: {}",
        stderr(&output)
    );

    for binary in ["genet-dev", "genet-agent-dev"] {
        let path = bin.join(binary);
        assert!(path.is_file(), "{binary} was not installed");
        let mode = fs::metadata(&path).expect("stat").permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "{binary} is not executable");
        // Runnable, not merely present: a bit set on a truncated file still
        // looks fine to `ls`.
        let ran = Command::new(&path)
            .output()
            .expect("run the installed binary");
        assert!(ran.status.success(), "{binary} did not run");
    }

    let said = String::from_utf8_lossy(&output.stdout);
    // The installer cannot edit someone's shell profile behind their back, so
    // the least it can do is say the directory is not on PATH.
    assert!(
        said.contains("not on your PATH"),
        "no PATH hint in:\n{said}"
    );
    assert!(
        said.contains("genet-dev daemon start"),
        "did not say what to run:\n{said}"
    );
}

#[test]
fn a_download_that_does_not_match_its_checksum_is_not_installed() {
    if skip() {
        return;
    }
    let release = fake_release();
    // Corrupted in transit, or replaced. Indistinguishable from here, which is
    // the point of checking.
    let asset = release.path().join(asset_name());
    let mut bytes = fs::read(&asset).expect("read the asset");
    let last = bytes.len() - 1;
    bytes[last] ^= 0xff;
    fs::write(&asset, bytes).expect("corrupt the asset");

    let home = TempDir::new().expect("temp home");
    let bin = home.path().join("bin");
    let output = install(release.path(), &bin);

    assert!(!output.status.success(), "a corrupt download was accepted");
    assert!(
        stderr(&output).contains("checksum mismatch"),
        "unhelpful refusal: {}",
        stderr(&output)
    );
    assert!(!bin.join("genet-dev").exists(), "installed anyway");
}

#[test]
fn a_release_with_no_checksums_is_refused_rather_than_trusted() {
    if skip() {
        return;
    }
    let release = fake_release();
    fs::remove_file(release.path().join("SHA256SUMS")).expect("drop the checksums");

    let home = TempDir::new().expect("temp home");
    let bin = home.path().join("bin");
    let output = install(release.path(), &bin);

    assert!(
        !output.status.success(),
        "an unverifiable download was accepted"
    );
    assert!(
        stderr(&output).contains("cannot be verified"),
        "unhelpful refusal: {}",
        stderr(&output)
    );
}

/// The tree's own copy of the script claims channel `dev`, and a dev install
/// has no artifacts to fetch. Without an explicit download base the script
/// must refuse — the alternative is someone piping the source checkout into
/// `sh` and quietly installing the official line over their dev machine.
#[test]
fn the_tree_installer_refuses_without_an_explicit_download_base() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh");
    let output = Command::new("sh")
        .arg(script)
        .env_remove("GENEHUB_DEV_DOWNLOAD_BASE")
        .output()
        .expect("run install.sh");
    assert!(!output.status.success(), "a dev install.sh ran anyway");
    assert!(
        stderr(&output).contains("channel: dev"),
        "the refusal does not say why:\n{}",
        stderr(&output)
    );
}

/// The script publishes no Linux arm64 build and says so; there is nothing to
/// install there, so there is nothing to assert either.
fn skip() -> bool {
    let unsupported = cfg!(target_os = "linux") && cfg!(target_arch = "aarch64");
    if unsupported {
        eprintln!("skipping: install.sh publishes no Linux arm64 build yet");
    }
    unsupported
}

/// A release directory laid out the way the release workflow lays one out: the
/// archive for this platform plus a `SHA256SUMS` beside it.
fn fake_release() -> TempDir {
    let dir = TempDir::new().expect("temp release");
    let staged = dir.path().join("staged");
    fs::create_dir_all(&staged).expect("staging dir");

    // Stand-ins rather than the real binaries: what is under test is the script,
    // and building the daemon here would make this test depend on a build it
    // does not care about.
    for binary in ["genet-dev", "genet-agent-dev"] {
        let path = staged.join(binary);
        fs::write(&path, "#!/bin/sh\necho ok\n").expect("write a stand-in");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let asset = dir.path().join(asset_name());
    let tar = Command::new("tar")
        .arg("-czf")
        .arg(&asset)
        .arg("-C")
        .arg(&staged)
        .arg("genet-dev")
        .arg("genet-agent-dev")
        .status()
        .expect("run tar");
    assert!(tar.success(), "tar failed");

    let sums = Command::new("sha256sum")
        .arg(asset_name())
        .current_dir(dir.path())
        .output()
        .expect("run sha256sum");
    fs::write(dir.path().join("SHA256SUMS"), sums.stdout).expect("write SHA256SUMS");

    dir
}

/// What `uname` on this machine makes the script ask for.
fn asset_name() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    format!("genet-dev-{os}-{arch}.tar.gz")
}

fn install(release: &Path, bin: &Path) -> Output {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh");
    Command::new("sh")
        .arg(script)
        // `file://` rather than a server: the transport is curl's business, and
        // what this test is about is which URL is asked for and what is done
        // with the answer.
        .env(
            "GENEHUB_DEV_DOWNLOAD_BASE",
            format!("file://{}", release.display()),
        )
        .env("GENEHUB_DEV_BIN_DIR", bin)
        .output()
        .expect("run install.sh")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}
