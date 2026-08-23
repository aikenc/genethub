//! `scripts/install.sh`, run end to end.
//!
//! This is the only way onto a machine with no graphical session, and it is a
//! shell script — the kind of thing that breaks silently and is discovered by a
//! stranger. It is run against a real release layout on disk with real `tar`,
//! `sha256sum` and target directory. A curl shim records and enforces the
//! transport flags without weakening production code to permit `file://`.
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

    for binary in ["genet-local", "genet-agent-local"] {
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
        said.contains("genet-local daemon start"),
        "did not say what to run:\n{said}"
    );
}

#[test]
fn an_explicit_install_can_restart_the_daemon_with_the_new_binary() {
    if skip() {
        return;
    }
    let release = fake_release();
    let home = TempDir::new().expect("temp home");
    let bin = home.path().join("bin");
    let calls = home.path().join("calls");

    let output = install_with_restart(release.path(), &bin, &calls);

    assert!(
        output.status.success(),
        "update failed: {}",
        stderr(&output)
    );
    assert_eq!(
        fs::read_to_string(calls).expect("new CLI recorded its call"),
        "daemon restart\n",
        "the installer did not restart through the newly installed CLI"
    );
}

#[test]
fn unsafe_download_bases_are_refused_before_fetching() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh");
    for base in [
        "http://downloads.example.invalid",
        "file:///tmp/release",
        "https://user:secret@downloads.example.invalid",
        "https://downloads.example.invalid/release?channel=dev",
        "https://downloads.example.invalid/release#asset",
    ] {
        let output = Command::new("sh")
            .arg(&script)
            .env("GENEHUB_LOCAL_DOWNLOAD_BASE", base)
            .output()
            .expect("run install.sh");
        assert!(
            !output.status.success(),
            "unsafe download base was accepted: {base}"
        );
        let problem = stderr(&output);
        assert!(
            problem.contains("download base"),
            "unsafe base {base} had an unhelpful refusal: {problem}"
        );
    }
}

#[test]
fn every_fetch_is_pinned_to_https_including_redirects() {
    let script =
        fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh"))
            .expect("read install.sh");
    assert!(script.contains("--proto '=https'"));
    assert!(script.contains("--proto-redir '=https'"));
    assert!(script.contains("--max-redirs 5"));
    assert!(script.contains("--globoff"));
    assert!(script.contains("wget --https-only --max-redirect=5"));
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
    assert!(!bin.join("genet-local").exists(), "installed anyway");
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
/// `sh` and quietly installing the stable line over their source checkout.
#[test]
fn the_tree_installer_refuses_without_an_explicit_download_base() {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh");
    let output = Command::new("sh")
        .arg(script)
        .env_remove("GENEHUB_LOCAL_DOWNLOAD_BASE")
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
    for binary in ["genet-local", "genet-agent-local"] {
        let path = staged.join(binary);
        let body = if binary == "genet-local" {
            "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"${GENEHUB_TEST_CALLS:-/dev/null}\"\necho ok\n"
        } else {
            "#!/bin/sh\necho ok\n"
        };
        fs::write(&path, body).expect("write a stand-in");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).expect("chmod");
    }

    let asset = dir.path().join(asset_name());
    let tar = Command::new("tar")
        .arg("-czf")
        .arg(&asset)
        .arg("-C")
        .arg(&staged)
        .arg("genet-local")
        .arg("genet-agent-local")
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
    format!("genet-local-{os}-{arch}.tar.gz")
}

fn install(release: &Path, bin: &Path) -> Output {
    run_install(release, bin, None)
}

fn install_with_restart(release: &Path, bin: &Path, calls: &Path) -> Output {
    run_install(release, bin, Some(calls))
}

fn run_install(release: &Path, bin: &Path, calls: Option<&Path>) -> Output {
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/install.sh");
    let tools = TempDir::new().expect("temp tools");
    let curl = tools.path().join("curl");
    fs::write(
        &curl,
        r#"#!/bin/sh
set -eu
proto=
proto_redir=
max_redirs=
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --proto) proto="$2"; shift 2 ;;
    --proto-redir) proto_redir="$2"; shift 2 ;;
    --max-redirs) max_redirs="$2"; shift 2 ;;
    -o) output="$2"; shift 2 ;;
    --globoff|-fsSL) shift ;;
    -*) echo "unexpected curl option: $1" >&2; exit 91 ;;
    *) url="$1"; shift ;;
  esac
done
[ "$proto" = "=https" ] || { echo "curl protocol was not pinned" >&2; exit 92; }
[ "$proto_redir" = "=https" ] || { echo "curl redirect protocol was not pinned" >&2; exit 93; }
[ "$max_redirs" = 5 ] || { echo "curl redirects were not bounded" >&2; exit 94; }
case "$url" in
  https://downloads.example.invalid/*) ;;
  *) echo "unexpected URL: $url" >&2; exit 95 ;;
esac
cp "$GENEHUB_TEST_RELEASE/${url##*/}" "$output"
"#,
    )
    .expect("write curl shim");
    fs::set_permissions(&curl, fs::Permissions::from_mode(0o755)).expect("chmod curl shim");

    let path = format!(
        "{}:{}",
        tools.path().display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut command = Command::new("sh");
    command
        .arg(script)
        .env("PATH", path)
        .env("GENEHUB_TEST_RELEASE", release)
        .env(
            "GENEHUB_LOCAL_DOWNLOAD_BASE",
            "https://downloads.example.invalid",
        )
        .env("GENEHUB_LOCAL_BIN_DIR", bin);
    if let Some(calls) = calls {
        command
            .env("GENEHUB_RESTART_DAEMON", "1")
            .env("GENEHUB_TEST_CALLS", calls);
    }
    command.output().expect("run install.sh")
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}
