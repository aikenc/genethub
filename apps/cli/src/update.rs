//! Linux self-update for the headless installation.
//!
//! The release build embeds the channel-stamped `install.sh`: we execute code
//! that shipped with this binary, not a fresh script fetched from the network.
//! That script downloads the channel's tarball and mandatory `SHA256SUMS`, then
//! asks the newly installed CLI to restart the daemon.

#[cfg(target_os = "linux")]
use std::io::Write;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};

use crate::fail;
#[cfg(not(target_os = "linux"))]
use crate::EXIT_INVALID_ARGS;
#[cfg(target_os = "linux")]
use crate::{ok, EXIT_FAILED};

#[cfg(target_os = "linux")]
const INSTALLER: &str = include_str!("../../../scripts/install.sh");

pub fn update(args: &[String]) -> i32 {
    if !args.is_empty() {
        return crate::usage();
    }

    #[cfg(not(target_os = "linux"))]
    fail(
        "unsupported",
        "CLI update is available on Linux; use the desktop updater on Windows",
        EXIT_INVALID_ARGS,
    );

    #[cfg(target_os = "linux")]
    install(INSTALLER)
}

#[cfg(target_os = "linux")]
fn install(script: &str) -> i32 {
    let mut child = match Command::new("sh")
        .arg("-s")
        .env("GENEHUB_RESTART_DAEMON", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => fail(
            "update_failed",
            &format!("could not start the updater: {error}"),
            EXIT_FAILED,
        ),
    };

    if let Err(error) = child
        .stdin
        .take()
        .expect("the updater stdin is piped")
        .write_all(script.as_bytes())
    {
        let _ = child.kill();
        fail(
            "update_failed",
            &format!("could not hand the installer to sh: {error}"),
            EXIT_FAILED,
        );
    }

    let output = match child.wait_with_output() {
        Ok(output) => output,
        Err(error) => fail(
            "update_failed",
            &format!("could not wait for the updater: {error}"),
            EXIT_FAILED,
        ),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.is_empty() {
        eprint!("{stdout}");
    }
    if !stderr.is_empty() {
        eprint!("{stderr}");
    }
    if !output.status.success() {
        fail(
            "update_failed",
            "the installer failed; details are on stderr",
            EXIT_FAILED,
        );
    }

    ok(serde_json::json!({
        "updated": true,
        "daemonRestarted": true,
        "channel": genet_daemon::channel::CHANNEL,
    }))
}
